import { describe, expect, test } from 'bun:test'
import { createSession, type SessionDeps } from '../../src/app/session.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type {
  AgentConnection,
  Baseline,
  RootRegistry,
  SnapshotStore,
} from '../../src/core/ports.ts'
import type {
  AgentEvent,
  FileDelta,
  FileReview,
  Finding,
  SessionState,
} from '../../src/core/types.ts'
import { fakeRepository } from '../support/gitRepo.ts'
import { EVERY_FILE } from '../support/rules.ts'

/**
 * The board while the agent is still working.
 *
 * A turn is minutes of silence broken by edits, and the only honest thing to show during it
 * is the work as it lands. The way that used to fail: an edit arriving while the risk check
 * was mid-analysis was *dropped*, because the pass was single-flighted by skipping rather than
 * by queueing — so the board disagreed with what was actually on disk. These tests are about
 * the board matching the tree, during the turn and once it ends.
 */

function delta(path: string): FileDelta {
  return {
    path,
    status: 'Modified',
    pureRename: false,
    binary: false,
    hunks: [{ startLine: 1, endLine: 1 }],
    addedLines: [`export const ${path.replace(/\W/g, '_')} = 2`],
    removedLines: [`export const ${path.replace(/\W/g, '_')} = 1`],
  }
}

const PATCH = `diff --git a/FILE b/FILE
--- a/FILE
+++ b/FILE
@@ -1,1 +1,1 @@
-export const value = 1
+export const value = 2`

/** A tree that grows, so a test can add a file mid-turn the way an agent does. Every capture
 *  is measured against the baseline, so the board is exactly what has been added so far. */
function growingTree() {
  const paths: string[] = []

  const snapshots: SnapshotStore = {
    capture: async () => `tree-${paths.length}`,
    delta: async () => paths.map(delta),
    patch: async (_base, _next, path) => PATCH.replaceAll('FILE', path),
    contents: async () => 'export const value = 2\n',
  }

  return { snapshots, add: (path: string) => paths.push(path) }
}

/** A reviewer held open, so a pass can be caught in flight rather than raced against. */
function heldSynthesizer() {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = 0

  return {
    release,
    started: () => started,
    reviewer: {
      reviewFile: async (): Promise<Finding[]> => {
        started += 1
        await held
        return []
      },
    },
  }
}

const ROOT = '/repo'

/** The single root every test in this file exercises, wrapped as a `RootRegistry` — just enough surface for `session.ts` to find the one root it was given. */
function rootRegistryFor(snapshots: SnapshotStore, baseline: Baseline): RootRegistry {
  const handle = { root: ROOT, snapshots, baseline }
  return {
    knownRoots: () => [handle],
    activate: () => handle,
    deactivate: () => {},
    rootFor: () => handle,
    teardown: async () => {},
  }
}

function harness(
  snapshots: SnapshotStore,
  reviewer: SessionDeps['reviewer'],
  overrides: { connect?: SessionDeps['connect'] } = {},
) {
  let emit: (event: AgentEvent) => void = () => {}
  let write: Parameters<SessionDeps['connect']>[1] = () => {
    throw new Error('writeFile was never wired — connect() has not been called yet')
  }
  const states: SessionState[] = []

  const baseline: Baseline = {
    resolve: async () => ({
      tree: 'tree-base',
      source: 'session-start',
      branch: 'main',
    }),
  }

  const connectImpl: SessionDeps['connect'] =
    overrides.connect ??
    ((): AgentConnection => ({
      start: async () => 'sess-1',
      loadSession: async (id: string) => id,
      prompt: async () => 'end_turn',
      cancel: async () => {},
      answerPermission: () => {},
      answerQuestion: () => {},
      setPermissionMode: async () => {},
      stop: () => {},
    }))

  const deps: SessionDeps = {
    connect: (onEvent, writeFile, requestPlanApproval, cwd) => {
      emit = onEvent
      write = writeFile
      return connectImpl(onEvent, writeFile, requestPlanApproval, cwd)
    },
    history: { listSessions: async () => [] },
    openAt: 'start',
    roots: rootRegistryFor(snapshots, baseline),
    repository: fakeRepository(ROOT),
    annotations: {
      bySession: async () => [],
      add: async () => {},
      remove: async () => {},
      markSent: async () => {},
      markUnsent: async () => {},
    },
    hidden: { bySession: async () => [], hide: async () => {}, show: async () => {} },
    editTarget: { read: async () => null, write: async () => {} },
    // Empty to begin with, so every file has to go through the reviewer — which is what
    // puts a pass in flight for the second edit to arrive during. It remembers what it is
    // given, because a fake that always missed would make a second pass look like it was
    // re-analysing work it had already paid for.
    cache: (() => {
      const store = new Map<string, FileReview>()
      return {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, review: FileReview) => {
          store.set(key, review)
        },
        claim: async () => true,
        release: async () => {},
        prune: async () => {},
      }
    })(),
    reviewer,
    rules: EVERY_FILE,
    reader: {
      read: async () => null,
      glob: async () => ({ paths: [], truncated: false }),
      grep: async () => ({ matches: [], truncated: false }),
    },
    config: DEFAULT_CONFIG,
    onChange: (state) => states.push(state),
  }

  return {
    session: createSession(deps),
    emit: (event: AgentEvent) => emit(event),
    /** Simulates the in-process write tool landing an edit. */
    write: (path: string) => write({ path, oldText: null, newText: `content for ${path}` }),
    states,
  }
}

/** Let queued work drain without depending on how many awaits deep it is. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const CLEAN = { reviewFile: async (): Promise<Finding[]> => [] }

describe('the board during a turn', () => {
  test('shows a change as soon as its edit lands', async () => {
    const tree = growingTree()
    const held = heldSynthesizer()
    const { session, write } = harness(tree.snapshots, held.reviewer)
    await session.start()

    tree.add('src/one.ts')
    await write('src/one.ts')
    await settle()

    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/one.ts'])
    held.release()
  })

  /**
   * The regression. The risk check takes tens of seconds per chunk and the agent does not wait
   * for it, so most edits in a real turn land while a pass is running. Dropping those left the
   * board frozen on whatever the first edit produced.
   */
  test('shows a change that lands while the risk check is still reading', async () => {
    const tree = growingTree()
    const held = heldSynthesizer()
    const { session, write } = harness(tree.snapshots, held.reviewer)
    await session.start()

    tree.add('src/one.ts')
    await write('src/one.ts')
    await settle()
    expect(held.started()).toBe(1)

    // The pass is blocked inside the reviewer, exactly where a real one spends its time.
    tree.add('src/two.ts')
    await write('src/two.ts')
    await settle()

    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/one.ts', 'src/two.ts'])
    held.release()
  })

  /** The list must not lose the spinner it is already showing to a recompute. */
  test('keeps the in-flight analysis visible while the list grows', async () => {
    const tree = growingTree()
    const held = heldSynthesizer()
    const { session, write } = harness(tree.snapshots, held.reviewer)
    await session.start()

    tree.add('src/one.ts')
    await write('src/one.ts')
    await settle()

    tree.add('src/two.ts')
    await write('src/two.ts')
    await settle()

    const first = session.state().chunks.find((chunk) => chunk.path === 'src/one.ts')
    expect(first?.status).toBe('analyzing')
    held.release()
  })

  /**
   * A pass that finished while edits were arriving has to pick them up, or the chunks it
   * missed stay unanalysed until something else happens to trigger a pass.
   */
  test('analyses what arrived while it was busy', async () => {
    const tree = growingTree()
    const held = heldSynthesizer()
    const { session, write } = harness(tree.snapshots, held.reviewer)
    await session.start()

    tree.add('src/one.ts')
    await write('src/one.ts')
    await settle()

    tree.add('src/two.ts')
    await write('src/two.ts')
    await settle()

    held.release()
    await settle()

    expect(held.started()).toBe(2)
  })
})

describe('the board without the write tool', () => {
  /** An agent that patches a file with Bash never calls the write tool; the finished Bash call
   *  is what tells the board to look again. */
  test('a finished Bash call refreshes the board', async () => {
    const tree = growingTree()
    const { session, emit } = harness(tree.snapshots, CLEAN)
    await session.start()

    tree.add('src/sed.ts')
    emit({ kind: 'tool', id: 't1', title: 'sed -i', toolKind: 'execute', status: 'in_progress' })
    await settle()
    expect(session.state().chunks).toEqual([])

    emit({ kind: 'tool', id: 't1', title: 'sed -i', toolKind: 'execute', status: 'completed' })
    await settle()
    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/sed.ts'])
  })
})

describe('the board when a turn ends', () => {
  /**
   * Whatever the board missed during the turn, the end of it catches: the board is re-read from
   * the tree, not folded from what was announced along the way.
   */
  test('holds every change in the tree, including ones nothing announced', async () => {
    const tree = growingTree()
    let promptCalls = 0
    const { session, write } = harness(tree.snapshots, CLEAN, {
      connect: () => ({
        start: async () => 'sess-1',
        loadSession: async (id: string) => id,
        prompt: async () => {
          promptCalls += 1
          // Both files land on disk, but only the first through the write tool.
          tree.add('src/one.ts')
          tree.add('src/two.ts')
          await write('src/one.ts')
          return 'end_turn'
        },
        cancel: async () => {},
        answerPermission: () => {},
        answerQuestion: () => {},
        setPermissionMode: async () => {},
        stop: () => {},
      }),
    })
    await session.start()

    await session.send('do the thing')
    await settle()

    expect(promptCalls).toBe(1)
    expect(session.state().status).toBe('idle')
    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/one.ts', 'src/two.ts'])
    expect(session.state().baseline).toBe('session-start')
  })

  /** Nothing blocks on the human any more: a turn with changes on the board still just ends. */
  test('ends without waiting on anyone, and every file gets its review', async () => {
    const tree = growingTree()
    const { session, write } = harness(tree.snapshots, CLEAN)
    await session.start()

    tree.add('src/one.ts')
    await write('src/one.ts')
    await session.send('do the thing')
    for (let i = 0; i < 20; i += 1) await settle()

    const chunks = session.state().chunks
    expect(chunks.map((chunk) => chunk.status)).toEqual(['ready'])
    expect(chunks[0]?.analysis?.riskLevel).toBe('none')
  })
})
