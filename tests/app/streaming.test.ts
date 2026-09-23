import { describe, expect, test } from 'bun:test'
import { createSession, type SessionDeps } from '../../src/app/session.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type {
  AgentConnection,
  Baseline,
  FindingStore,
  Reviewer,
  ReviewInput,
  RootRegistry,
  SnapshotStore,
} from '../../src/core/ports.ts'
import type { AgentEvent, FileDelta, Finding, SessionState } from '../../src/core/types.ts'
import { fakeRepository } from '../support/gitRepo.ts'

/**
 * The board while the agent is still working, and the review once it stops.
 *
 * A turn is minutes of silence broken by edits. The board follows them as they land — it is a
 * git snapshot, and cheap — but the review waits for the turn to end: reviewing work the agent
 * is still in the middle of is reviewing something about to change, and each review is a whole
 * agent run. These tests are about both halves: the board matching the tree during the turn,
 * and exactly one review of what the turn changed once it ends.
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

/**
 * A tree that grows and changes, so a test can edit files mid-turn the way an agent does. Every
 * capture is measured against the baseline; each edit gives the tree a new id and the file new
 * contents, which is what a review is current against.
 */
function growingTree() {
  const versions = new Map<string, number>()
  let revision = 0

  const snapshots: SnapshotStore = {
    capture: async () => `tree-${revision}`,
    delta: async () => [...versions.keys()].map(delta),
    patch: async (_base, _next, path) => PATCH.replaceAll('FILE', path),
    contents: async (_tree, path) => `export const value = ${versions.get(path) ?? 0}\n`,
  }

  const edit = (path: string) => {
    versions.set(path, (versions.get(path) ?? 0) + 1)
    revision += 1
  }
  return { snapshots, edit }
}

/** A reviewer that records what it is asked. With `hold`, each review waits for its own
 *  `release(n)`, so a review can be caught in flight rather than raced against. */
function reviewerFor(options: { hold?: boolean } = {}) {
  const releases: (() => void)[] = []
  const inputs: ReviewInput[] = []
  const reviewer: Reviewer = {
    review: async (input) => {
      inputs.push(input)
      if (options.hold === true) {
        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })
      }
      return new Map<string, Finding[]>(input.files.map((file) => [file.path, []]))
    },
  }
  return {
    reviewer,
    inputs,
    release: (index: number) => releases[index]?.(),
    reviewed: () => inputs.map((input) => input.files.map((file) => file.path)),
  }
}

const ROOT = '/repo'

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

const noFindings: FindingStore = { bySession: async () => [], put: async () => {} }

/** `duringTurn` is what the agent does inside a prompt, before it stops. */
function harness(
  snapshots: SnapshotStore,
  reviewer: Reviewer,
  options: { duringTurn?: () => Promise<void> | void } = {},
) {
  let emit: (event: AgentEvent) => void = () => {}
  let write: Parameters<SessionDeps['connect']>[1] = () => {
    throw new Error('writeFile was never wired — connect() has not been called yet')
  }
  const states: SessionState[] = []

  const baseline: Baseline = {
    resolve: async () => ({ tree: 'tree-base', source: 'session-start', branch: 'main' }),
  }

  const connection = (): AgentConnection => ({
    start: async () => 'sess-1',
    loadSession: async (id: string) => id,
    prompt: async () => {
      await options.duringTurn?.()
      return 'end_turn'
    },
    cancel: async () => {},
    answerPermission: () => {},
    answerQuestion: () => {},
    setPermissionMode: async () => {},
    stop: () => {},
  })

  const deps: SessionDeps = {
    connect: (onEvent, writeFile) => {
      emit = onEvent
      write = writeFile
      return connection()
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
    reviewer,
    findings: noFindings,
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
  for (let round = 0; round < 10; round += 1) {
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** A prompt the test holds open until it says so. */
function openTurn() {
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { wait: () => done, finish }
}

describe('the board during a turn', () => {
  test('shows each change as soon as its edit lands, unreviewed', async () => {
    const tree = growingTree()
    const review = reviewerFor()
    const turn = openTurn()
    const { session, write } = harness(tree.snapshots, review.reviewer, {
      duringTurn: turn.wait,
    })
    await session.start()

    const sending = session.send('go')
    await settle()
    tree.edit('src/one.ts')
    await write('src/one.ts')
    await settle()
    tree.edit('src/two.ts')
    await write('src/two.ts')
    await settle()

    const chunks = session.state().chunks
    expect(chunks.map((chunk) => chunk.path)).toEqual(['src/one.ts', 'src/two.ts'])
    expect(chunks.map((chunk) => chunk.status)).toEqual(['pending', 'pending'])
    // The agent is still working: nothing has been sent for review.
    expect(review.inputs).toHaveLength(0)

    turn.finish()
    await sending
  })

  /** An agent that patches a file with Bash never calls the write tool; the finished Bash call
   *  is what tells the board to look again. */
  test('a finished Bash call refreshes the board', async () => {
    const tree = growingTree()
    const { session, emit } = harness(tree.snapshots, reviewerFor().reviewer)
    await session.start()

    tree.edit('src/sed.ts')
    emit({ kind: 'tool', id: 't1', title: 'sed -i', toolKind: 'execute', status: 'in_progress' })
    await settle()
    expect(session.state().chunks).toEqual([])

    emit({ kind: 'tool', id: 't1', title: 'sed -i', toolKind: 'execute', status: 'completed' })
    await settle()
    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/sed.ts'])
  })
})

describe('the review when a turn ends', () => {
  test('reviews everything the turn changed, once, in one run', async () => {
    const tree = growingTree()
    const review = reviewerFor()
    const { session, write } = harness(tree.snapshots, review.reviewer, {
      duringTurn: async () => {
        // Both land on disk, but only the first through the write tool.
        tree.edit('src/one.ts')
        await write('src/one.ts')
        tree.edit('src/two.ts')
      },
    })
    await session.start()

    await session.send('do the thing')
    await settle()

    expect(session.state().status).toBe('idle')
    expect(review.reviewed()).toEqual([['src/one.ts', 'src/two.ts']])
    expect(session.state().chunks.map((chunk) => chunk.status)).toEqual(['ready', 'ready'])
    expect(session.state().chunks[0]?.analysis?.riskLevel).toBe('none')
  })

  test('a turn that changed nothing is not reviewed', async () => {
    const tree = growingTree()
    const review = reviewerFor()
    const { session } = harness(tree.snapshots, review.reviewer)
    await session.start()

    await session.send('just a question')
    await settle()

    expect(review.inputs).toHaveLength(0)
  })

  /**
   * A change the agent did not make — by hand, between turns — is on the board, but a turn that
   * changes nothing does not pay to review it. It waits for the next turn that does, or for
   * `reviewNow`.
   */
  test('a turn that changed nothing leaves an earlier hand edit unreviewed', async () => {
    const tree = growingTree()
    const review = reviewerFor()
    const { session } = harness(tree.snapshots, review.reviewer)
    await session.start()

    tree.edit('src/by-hand.ts')
    await session.send('just a question')
    await settle()

    expect(review.inputs).toHaveLength(0)
    expect(session.state().chunks[0]?.status).toBe('pending')
  })

  test('the next turn that changes something reviews only what has no current review', async () => {
    const tree = growingTree()
    const review = reviewerFor()
    let next = 'src/one.ts'
    const { session } = harness(tree.snapshots, review.reviewer, {
      duringTurn: () => tree.edit(next),
    })
    await session.start()

    await session.send('first')
    await settle()
    next = 'src/two.ts'
    await session.send('second')
    await settle()

    expect(review.reviewed()).toEqual([['src/one.ts'], ['src/two.ts']])
  })

  /**
   * A review is current against the file as it stood when the review STARTED. A file the agent
   * changes again while it is being read must not come out looking reviewed.
   */
  test('a file changed during its review stays unreviewed', async () => {
    const tree = growingTree()
    const review = reviewerFor({ hold: true })
    let turns = 0
    const { session, write } = harness(tree.snapshots, review.reviewer, {
      duringTurn: async () => {
        turns += 1
        tree.edit('src/one.ts')
        await write('src/one.ts')
      },
    })
    await session.start()

    await session.send('first')
    await settle()
    expect(review.inputs).toHaveLength(1)
    expect(session.state().chunks[0]?.status).toBe('analyzing')

    // A second turn edits the same file while the first review is still reading it.
    await session.send('second')
    await settle()
    review.release(0)
    await settle()

    expect(turns).toBe(2)
    // The first review lands on a file that has since changed: it is not the file's review, so
    // the file reads under review again (the second turn's), never ready off the stale one.
    expect(review.inputs).toHaveLength(2)
    expect(session.state().chunks[0]?.status).toBe('analyzing')

    review.release(1)
    await settle()
    expect(session.state().chunks[0]?.status).toBe('ready')
  })
})
