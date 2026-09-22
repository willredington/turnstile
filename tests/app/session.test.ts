import { describe, expect, test } from 'bun:test'
import { createSession, type SessionDeps } from '../../src/app/session.ts'
import { PLAN_PATH } from '../../src/core/annotations.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type {
  AgentConnection,
  AgentConnectionFactory,
  AnalysisCache,
  AnnotationStore,
  Baseline,
  EditTarget,
  HiddenFileStore,
  RepoReader,
  Repository,
  Reviewer,
  RootHandle,
  RootRegistry,
  SnapshotStore,
} from '../../src/core/ports.ts'
import type {
  AgentEvent,
  Annotation,
  FileDelta,
  FileReview,
  Finding,
  HiddenFile,
  SessionSummary,
} from '../../src/core/types.ts'
import { fakeRepository } from '../support/gitRepo.ts'
import { EVERY_FILE } from '../support/rules.ts'
import { type RecordingTelemetry, recordingTelemetry } from '../support/telemetry.ts'

/**
 * The session, with every port faked.
 *
 * What matters here is what the session does and, as much, what it no longer does: a turn ends
 * without blocking on anyone, the board is whatever differs from the baseline, and a note
 * reaches the agent only when the human sends it.
 */

const ROOT = '/repo'

function delta(path: string): FileDelta {
  return {
    path,
    status: 'Modified',
    pureRename: false,
    binary: false,
    hunks: [{ startLine: 1, endLine: 1 }],
    addedLines: ['export const value = 2'],
    removedLines: ['export const value = 1'],
  }
}

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-export const value = 1
+export const value = 2`

/** A working tree whose difference from the baseline a test sets directly. */
function fakeSnapshots(initial: FileDelta[] = []): SnapshotStore & {
  setDeltas: (deltas: FileDelta[]) => void
  failWith: (error: Error | null) => void
} {
  let deltas = initial
  let failure: Error | null = null
  return {
    setDeltas: (next) => {
      deltas = next
    },
    failWith: (error) => {
      failure = error
    },
    capture: async () => 'tree-next',
    delta: async () => {
      if (failure !== null) throw failure
      return deltas
    },
    // Keyed off the path asked for: the chunker reads the patch header.
    patch: async (_base, _next, path) => PATCH.replaceAll('src/a.ts', path),
    contents: async () => 'export const value = 1\n',
  }
}

const fakeBaseline: Baseline = {
  resolve: async () => ({ tree: 'tree-base', source: 'session-start', branch: 'turnstile/s' }),
}

/** A `RootRegistry` over one fixed root, inactive until the session opens its worktree. */
function fakeRootRegistry(handle: RootHandle): RootRegistry & { activations: string[] } {
  let active = false
  const activations: string[] = []
  return {
    activations,
    knownRoots: () => (active ? [handle] : []),
    activate: (_root, sessionId) => {
      active = true
      activations.push(sessionId)
      return handle
    },
    deactivate: () => {
      active = false
    },
    rootFor: (absolutePath) =>
      active && (absolutePath === handle.root || absolutePath.startsWith(`${handle.root}/`))
        ? handle
        : null,
    teardown: async () => {
      active = false
    },
  }
}

function fakeEditTarget(files: Record<string, string> = {}): EditTarget & {
  files: Record<string, string>
} {
  const store = { ...files }
  return {
    files: store,
    read: async (_root, path) => store[path] ?? null,
    write: async (_root, path, text) => {
      store[path] = text
    },
  }
}

function fakeAnnotations(seed: Annotation[] = []): AnnotationStore & { notes: Annotation[] } {
  const notes = [...seed]
  return {
    notes,
    bySession: async (sessionId) => notes.filter((note) => note.sessionId === sessionId),
    add: async (annotation) => {
      notes.push(annotation)
    },
    remove: async (sessionId, id) => {
      const at = notes.findIndex((note) => note.id === id && note.sessionId === sessionId)
      if (at >= 0) notes.splice(at, 1)
    },
    markSent: async (sessionId, ids, at) => {
      for (const [index, note] of notes.entries()) {
        if (note.sessionId === sessionId && ids.includes(note.id) && note.sentAt === null) {
          notes[index] = { ...note, sentAt: at }
        }
      }
    },
    markUnsent: async (sessionId, ids) => {
      for (const [index, note] of notes.entries()) {
        if (note.sessionId === sessionId && ids.includes(note.id)) {
          notes[index] = { ...note, sentAt: null }
        }
      }
    },
  }
}

const NO_READER: RepoReader = {
  read: async () => null,
  glob: async () => ({ paths: [], truncated: false }),
  grep: async () => ({ matches: [], truncated: false }),
}

function fakeCache(seed: Record<string, FileReview> = {}): AnalysisCache {
  const entries = new Map(Object.entries(seed))
  return {
    get: async (key) => entries.get(key) ?? null,
    put: async (key, review) => {
      entries.set(key, review)
    },
    claim: async () => true,
    release: async () => {},
    prune: async () => {},
  }
}

/** A connection whose turns are scripted, recording every prompt it is given. */
function fakeConnection(stopReasons: string[] = ['end_turn']) {
  const prompts: string[] = []
  const answered: { id: string; optionId: string }[] = []
  const permissionModes: string[] = []
  const loaded: string[] = []
  let call = 0
  let emit: (event: AgentEvent) => void = () => {}
  let write: Parameters<AgentConnectionFactory>[1] = () => {
    throw new Error('writeFile was never wired')
  }
  let planApproval: Parameters<AgentConnectionFactory>[2] = () => {
    throw new Error('requestPlanApproval was never wired')
  }
  let onPrompt: ((text: string) => void) | null = null
  let hang: Promise<void> | null = null
  let release: () => void = () => {}
  let failure: Error | null = null
  let sessions: SessionSummary[] = []
  let minted = 0

  const connect: AgentConnectionFactory = (onEvent, writeFile, approval): AgentConnection => {
    emit = onEvent
    write = writeFile
    planApproval = approval
    return {
      start: async (id) => id,
      loadSession: async (id) => {
        loaded.push(id)
        return id
      },
      prompt: async (text) => {
        prompts.push(text)
        onPrompt?.(text)
        if (failure !== null) {
          const error = failure
          failure = null
          throw error
        }
        if (hang !== null) {
          const waiting = hang
          hang = null
          await waiting
        }
        const reason = stopReasons[Math.min(call, stopReasons.length - 1)] ?? 'end_turn'
        call += 1
        return reason
      },
      cancel: async () => {},
      answerPermission: (id, optionId) => {
        answered.push({ id, optionId })
      },
      answerQuestion: () => {},
      setPermissionMode: async (mode) => {
        permissionModes.push(mode)
      },
      stop: () => {},
    }
  }

  return {
    connect,
    history: { listSessions: async () => sessions },
    mintSessionId: () => `sess-${++minted}`,
    prompts,
    answered,
    permissionModes,
    loaded,
    emit: (event: AgentEvent) => emit(event),
    write: (input: Parameters<Parameters<AgentConnectionFactory>[1]>[0]) => write(input),
    requestPlanApproval: (plan: string) => planApproval(plan),
    duringPrompt: (fn: (text: string) => void) => {
      onPrompt = fn
    },
    setSessions: (next: SessionSummary[]) => {
      sessions = next
    },
    /** The next `prompt()` blocks until `releasePrompt()`. */
    hangNextPrompt: () => {
      hang = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    releasePrompt: () => release(),
    /** The next `prompt()` fails, the way it does when the agent's process dies mid-turn. */
    failNextPrompt: (error: Error) => {
      failure = error
    },
  }
}

function fakeHidden(): HiddenFileStore & { entries: HiddenFile[] } {
  const entries: HiddenFile[] = []
  const at = (sessionId: string, root: string, path: string): number =>
    entries.findIndex(
      (entry) => entry.sessionId === sessionId && entry.root === root && entry.path === path,
    )
  return {
    entries,
    bySession: async (sessionId) => entries.filter((entry) => entry.sessionId === sessionId),
    hide: async (entry) => {
      const index = at(entry.sessionId, entry.root, entry.path)
      if (index >= 0) entries.splice(index, 1)
      entries.push(entry)
    },
    show: async (sessionId, root, path) => {
      const index = at(sessionId, root, path)
      if (index >= 0) entries.splice(index, 1)
    },
  }
}

function harness(
  options: {
    deltas?: FileDelta[]
    stopReasons?: string[]
    annotations?: Annotation[]
    files?: Record<string, string>
    repository?: Repository
    cache?: AnalysisCache
    reviewer?: Reviewer
    openAt?: SessionDeps['openAt']
    telemetry?: RecordingTelemetry
  } = {},
) {
  const connection = fakeConnection(options.stopReasons)
  const snapshots = fakeSnapshots(options.deltas)
  const roots = fakeRootRegistry({ root: ROOT, snapshots, baseline: fakeBaseline })
  const annotations = fakeAnnotations(options.annotations)
  const hidden = fakeHidden()
  const editTarget = fakeEditTarget(options.files)
  const analyzed: string[] = []
  const deps: SessionDeps = {
    connect: connection.connect,
    history: connection.history,
    mintSessionId: connection.mintSessionId,
    openAt: options.openAt ?? 'start',
    roots,
    repository: options.repository ?? fakeRepository(ROOT),
    annotations,
    hidden,
    editTarget,
    cache: options.cache ?? fakeCache(),
    reviewer: options.reviewer ?? {
      reviewFile: async (input) => {
        analyzed.push(input.path)
        return []
      },
    },
    rules: EVERY_FILE,
    reader: NO_READER,
    config: DEFAULT_CONFIG,
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  }
  return {
    session: createSession(deps),
    connection,
    snapshots,
    roots,
    annotations,
    hidden,
    editTarget,
    analyzed,
  }
}

/** Let coalesced board refreshes and background analysis run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (!condition()) throw new Error('condition never became true')
}

const NOTE = {
  root: ROOT,
  path: 'src/a.ts',
  line: 1,
  side: 'new' as const,
  lineText: 'export const value = 2',
}

describe('starting', () => {
  test('a directory that is not a git repository opens no session', async () => {
    const { session, connection } = harness({ repository: fakeRepository(ROOT, 'not-git') })
    await session.start()

    expect(session.state().tracking).toBe('not-git')
    expect(session.state().sessionId).toBe('')
    await session.send('hello')
    expect(connection.prompts).toEqual([])
  })

  test('nothing is opened until the first prompt', async () => {
    const { session, roots } = harness({ openAt: 'first-prompt' })
    await session.start()

    expect(session.state().status).toBe('idle')
    expect(session.state().roots).toEqual([])
    expect(roots.activations).toEqual([])
  })

  test('the first prompt opens the session under its id', async () => {
    const { session, roots } = harness({ openAt: 'first-prompt' })
    await session.start()
    await session.send('do it')

    expect(roots.activations).toEqual(['sess-1'])
    expect(session.state().roots).toEqual([{ root: ROOT }])
  })
})

describe('a turn', () => {
  test('whose agent died ends idle, saying why, and the next message still goes', async () => {
    const { session, connection } = harness()
    await session.start()
    connection.failNextPrompt(new Error('Claude Code process terminated by signal SIGKILL'))
    await session.send('hey')

    expect(session.state().status).toBe('idle')
    expect(session.state().transcript.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'bad',
      text: 'Claude Code process terminated by signal SIGKILL',
    })

    await session.send('hey again')
    expect(connection.prompts).toEqual(['hey', 'hey again'])
    expect(session.state().status).toBe('idle')
  })

  test('ends idle, with no review to sit through', async () => {
    const { session, connection } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('change a')

    expect(connection.prompts).toEqual(['change a'])
    expect(session.state().status).toBe('idle')
    expect(session.state().transcript[0]).toMatchObject({ kind: 'user', text: 'change a' })
  })

  test('the board is every difference from the baseline, whoever made it', async () => {
    // Neither path went through the write tool or a Bash call: there is no attribution any
    // more, so anything in the worktree that differs from where the session started is on it.
    const { session } = harness({ deltas: [delta('src/a.ts'), delta('src/b.ts')] })
    await session.start()
    await session.send('go')

    expect(
      session
        .state()
        .chunks.map((chunk) => chunk.path)
        .sort(),
    ).toEqual(['src/a.ts', 'src/b.ts'])
    expect(session.state().baseline).toBe('session-start')
  })

  test('a change that goes away leaves the board', async () => {
    const { session, snapshots } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('go')
    expect(session.state().chunks).toHaveLength(1)

    snapshots.setDeltas([])
    await session.send('undo it')
    expect(session.state().chunks).toEqual([])
  })

  /**
   * The board rebuild and the review run fire-and-forget off every agent event, so a failure
   * in one used to reach the top as an unhandled rejection and take the whole process down
   * mid-session. It has to be survivable, visible, and recoverable instead.
   */
  test('a failing background job is reported, and the session carries on', async () => {
    const { session, snapshots } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('go')
    expect(session.state().chunks).toHaveLength(1)

    snapshots.failWith(new Error('git exploded'))
    await session.send('again')

    const notices = session
      .state()
      .transcript.filter((entry) => entry.kind === 'notice')
      .map((entry) => (entry.kind === 'notice' ? entry.text : ''))
    expect(notices.some((text) => text.includes('git exploded'))).toBe(true)

    // And it recovers: the failure must not have wedged the coalesced runner.
    snapshots.failWith(null)
    await session.send('once more')
    expect(session.state().chunks).toHaveLength(1)
  })

  test('a background failure that keeps happening is only said once', async () => {
    // These fire on every edit and every tool call, so a stuck failure would otherwise bury
    // the conversation under identical notices.
    const { session, snapshots } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('go')

    const complaints = (): number =>
      session
        .state()
        .transcript.filter(
          (entry) => entry.kind === 'notice' && entry.text.includes('git exploded'),
        ).length

    snapshots.failWith(new Error('git exploded'))
    await session.send('again')
    const afterFirst = complaints()
    expect(afterFirst).toBeGreaterThan(0)

    await session.send('and again')
    expect(complaints()).toBe(afterFirst)
  })

  test('a turn that does not end normally says so, and still ends', async () => {
    const { session } = harness({ stopReasons: ['cancelled'] })
    await session.start()
    await session.send('go')

    expect(session.state().status).toBe('idle')
    expect(session.state().transcript.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Turn cancelled.',
    })
  })

  test('a send while a turn is running is refused', async () => {
    const { session, connection } = harness()
    await session.start()
    connection.hangNextPrompt()
    const first = session.send('one')
    await until(() => session.state().status === 'working')

    await session.send('two')
    connection.releasePrompt()
    await first

    expect(connection.prompts).toEqual(['one'])
  })

  test('each changed file is reviewed in the background', async () => {
    const { session, analyzed } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('go')
    await settle()

    expect(analyzed).toEqual(['src/a.ts'])
    expect(session.state().chunks[0]).toMatchObject({
      status: 'ready',
      analysis: { riskLevel: 'none', findings: [] },
    })
  })

  /** Findings land on the chunk they overlap; the rest stay with the file rather than vanish. */
  test('findings map onto chunks, and the rest onto the file', async () => {
    const finding = (line: number, severity: Finding['severity']): Finding => ({
      path: 'src/a.ts',
      startLine: line,
      endLine: line,
      severity,
      rule: 'no-default-exports',
      message: `at ${line}`,
    })
    const { session } = harness({
      deltas: [delta('src/a.ts')],
      reviewer: {
        reviewFile: async (input) => [
          finding(input.chunks[0]?.startLine ?? 1, 'medium'),
          finding(9999, 'high'),
        ],
      },
    })
    await session.start()
    await session.send('go')
    await settle()

    const [chunk] = session.state().chunks
    expect(chunk?.analysis?.riskLevel).toBe('medium')
    expect(chunk?.analysis?.findings.map((f) => f.message)).toHaveLength(1)
    expect(session.state().fileFindings).toEqual([
      { root: ROOT, path: 'src/a.ts', findings: [finding(9999, 'high')] },
    ])
  })

  test('a file not worth a risk check says why instead', async () => {
    const { session, analyzed } = harness({ deltas: [delta('bun.lock')] })
    await session.start()
    await session.send('go')
    await settle()

    expect(analyzed).toEqual([])
    expect(session.state().chunks[0]?.status).toBe('skipped')
  })
})

describe('the write tool', () => {
  test('writes, and the board follows', async () => {
    const { session, connection, editTarget, snapshots } = harness({
      files: { 'src/a.ts': 'export const value = 1\n' },
    })
    await session.start()
    const before = session.state().diffRevision

    snapshots.setDeltas([delta('src/a.ts')])
    const result = await connection.write({
      path: 'src/a.ts',
      oldText: 'value = 1',
      newText: 'value = 2',
    })
    await settle()

    expect(result).toEqual({ decision: 'allow', fileContent: 'export const value = 2\n' })
    expect(editTarget.files['src/a.ts']).toBe('export const value = 2\n')
    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/a.ts'])
    expect(session.state().diffRevision).toBeGreaterThan(before)
  })

  test('refuses text that is not in the file', async () => {
    const { session, connection, editTarget } = harness({
      files: { 'src/a.ts': 'export const value = 1\n' },
    })
    await session.start()

    const result = await connection.write({ path: 'src/a.ts', oldText: 'nope', newText: 'x' })
    expect(result.decision).toBe('reject')
    expect(editTarget.files['src/a.ts']).toBe('export const value = 1\n')
  })

  test('refuses a path outside the worktree', async () => {
    const { session, connection } = harness()
    await session.start()

    const result = await connection.write({ path: '../elsewhere.ts', oldText: null, newText: 'x' })
    expect(result.decision).toBe('reject')
  })

  test('a finished Bash call re-reads the tree', async () => {
    const { session, connection, snapshots } = harness()
    await session.start()

    snapshots.setDeltas([delta('src/sed.ts')])
    connection.emit({
      kind: 'tool',
      id: 't1',
      title: 'sed',
      toolKind: 'execute',
      status: 'pending',
    })
    connection.emit({
      kind: 'tool',
      id: 't1',
      title: 'sed',
      toolKind: 'execute',
      status: 'completed',
    })
    await settle()

    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/sed.ts'])
  })

  /** `NotebookEdit`, an MCP tool, a subagent: anything but a read can change a file. */
  test('any other finished tool call re-reads the tree too', async () => {
    const { session, connection, snapshots } = harness()
    await session.start()

    snapshots.setDeltas([delta('src/notebook.ts')])
    connection.emit({ kind: 'tool', id: 't1', title: 'x', toolKind: 'other', status: 'completed' })
    await settle()

    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/notebook.ts'])
  })

  test('a finished read does not', async () => {
    const { session, connection, snapshots } = harness()
    await session.start()

    snapshots.setDeltas([delta('src/read.ts')])
    connection.emit({ kind: 'tool', id: 't1', title: 'x', toolKind: 'read', status: 'completed' })
    await settle()

    expect(session.state().chunks).toEqual([])
  })
})

describe('the review', () => {
  /** A failure used to leave the chunk on "analyzing" forever, looking like a check never run. */
  test('a failed review is reported on the chunk, and retried on the next change', async () => {
    let fail = true
    const { session, connection, snapshots } = harness({
      reviewer: {
        reviewFile: async () => {
          if (fail) throw new Error('no API key')
          return []
        },
      },
    })
    await session.start()

    snapshots.setDeltas([delta('src/a.ts')])
    connection.emit({
      kind: 'tool',
      id: 't1',
      title: 'x',
      toolKind: 'execute',
      status: 'completed',
    })
    await until(
      () =>
        session.state().chunks[0]?.reason !== null &&
        session.state().chunks[0]?.reason !== undefined,
    )

    expect(session.state().chunks[0]).toMatchObject({
      status: 'pending',
      reason: 'Review failed: no API key',
    })

    fail = false
    connection.emit({
      kind: 'tool',
      id: 't2',
      title: 'x',
      toolKind: 'execute',
      status: 'completed',
    })
    await until(() => session.state().chunks[0]?.status === 'ready')

    expect(session.state().chunks[0]).toMatchObject({
      reason: null,
      analysis: { riskLevel: 'none' },
    })
  })
})

describe('notes', () => {
  describe('are cleared when the lines they are about change', () => {
    test('an edit to the noted lines clears them, sent or not', async () => {
      const { session, connection, annotations } = harness({
        files: { 'src/a.ts': 'export const value = 2\n' },
      })
      await session.start()
      await session.annotate({ ...NOTE, body: 'sent one' })
      await session.sendNotes()
      await session.annotate({ ...NOTE, body: 'unsent one' })
      expect(session.state().annotations).toHaveLength(2)

      await connection.write({ path: 'src/a.ts', oldText: 'value = 2', newText: 'value = 3' })
      await settle()

      expect(session.state().annotations).toEqual([])
      expect(annotations.notes).toEqual([])
    })

    test('a note on another file stays', async () => {
      const { session, connection } = harness({
        files: { 'src/a.ts': 'export const value = 2\n', 'src/b.ts': 'export const b = 1\n' },
      })
      await session.start()
      await session.annotate({
        ...NOTE,
        path: 'src/b.ts',
        lineText: 'export const b = 1',
        body: 'on b',
      })

      await connection.write({ path: 'src/a.ts', oldText: 'value = 2', newText: 'value = 3' })
      await settle()

      expect(session.state().annotations.map((note) => note.body)).toEqual(['on b'])
    })

    test('an edit elsewhere in the same file leaves the note alone', async () => {
      const { session, connection } = harness({
        files: { 'src/a.ts': 'export const value = 2\nexport const other = 9\n' },
      })
      await session.start()
      await session.annotate({ ...NOTE, body: 'about line 1' })

      await connection.write({ path: 'src/a.ts', oldText: 'other = 9', newText: 'other = 10' })
      await settle()

      expect(session.state().annotations.map((note) => note.body)).toEqual(['about line 1'])
    })

    /** Bash can change a file without the write tool. */
    test('a change made through Bash clears them too', async () => {
      const { session, connection, editTarget } = harness({
        files: { 'src/a.ts': 'export const value = 2\n' },
      })
      await session.start()
      await session.annotate({ ...NOTE, body: 'why 2?' })

      editTarget.files['src/a.ts'] = 'export const value = 9\n'
      connection.emit({
        kind: 'tool',
        id: 't1',
        title: 'sed',
        toolKind: 'execute',
        status: 'completed',
      })
      await settle()

      expect(session.state().annotations).toEqual([])
    })

    /** Written before notes recorded their file's hash — there is nothing to compare. */
    test('a note with no recorded hash is left alone', async () => {
      const { session, connection } = harness({
        files: { 'src/a.ts': 'export const value = 2\n' },
        annotations: [
          {
            ...NOTE,
            id: 'old',
            sessionId: 'sess-1',
            rangeStart: 1,
            body: 'from before',
            at: '2026-09-01T12:00:00.000Z',
            sentAt: null,
          },
        ],
      })
      await session.start()

      await connection.write({ path: 'src/a.ts', oldText: 'value = 2', newText: 'value = 3' })
      await settle()

      expect(session.state().annotations.map((note) => note.body)).toEqual(['from before'])
    })
  })

  test('a note is kept, not sent', async () => {
    const { session, connection, annotations } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })
    await settle()

    expect(connection.prompts).toEqual([])
    expect(annotations.notes).toHaveLength(1)
    expect(session.state().annotations[0]).toMatchObject({
      sessionId: 'sess-1',
      root: ROOT,
      path: 'src/a.ts',
      line: 1,
      rangeStart: 1,
      body: 'why 2?',
      sentAt: null,
    })
  })

  test('a note on a file the agent never touched is kept and sent like any other', async () => {
    const { session, connection } = harness({
      deltas: [delta('src/a.ts')],
      files: { 'src/untouched.ts': 'export const other = 1\n' },
    })
    await session.start()
    await session.annotate({
      ...NOTE,
      path: 'src/untouched.ts',
      lineText: 'export const other = 1',
      body: 'follow this pattern',
    })
    // An edit elsewhere refreshes the notes; this one's file did not change, so it stays.
    await connection.write({ path: 'src/a.ts', oldText: 'value = 2', newText: 'value = 3' })
    await settle()
    expect(session.state().annotations.map((note) => note.path)).toEqual(['src/untouched.ts'])

    await session.sendNotes('')
    expect(connection.prompts.at(-1)).toContain('- src/untouched.ts:1 — follow this pattern')
  })

  test('an empty note, or one outside the worktree, is not kept', async () => {
    const { session, annotations } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: '   ' })
    await session.annotate({ ...NOTE, root: '/elsewhere', body: 'hi' })

    expect(annotations.notes).toEqual([])
  })

  test('an ordinary prompt never carries them', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })
    await session.send('keep going')

    expect(connection.prompts).toEqual(['keep going'])
    expect(session.state().annotations[0]?.sentAt).toBeNull()
  })

  test('sending them hands every unsent note over, ahead of what was typed', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })
    await session.annotate({ ...NOTE, line: 3, rangeStart: 2, body: 'and this' })
    await session.sendNotes('then carry on')

    expect(connection.prompts).toHaveLength(1)
    const prompt = connection.prompts[0] ?? ''
    expect(prompt).toContain('- src/a.ts:1 — why 2?')
    expect(prompt).toContain('- src/a.ts:2-3 — and this')
    expect(prompt.indexOf('why 2?')).toBeLessThan(prompt.indexOf('then carry on'))
    expect(session.state().annotations.every((note) => note.sentAt !== null)).toBe(true)
    expect(session.state().transcript[0]).toMatchObject({
      kind: 'user',
      text: 'then carry on',
      notes: [
        { path: 'src/a.ts', line: 1, rangeStart: 1, body: 'why 2?' },
        { path: 'src/a.ts', line: 3, rangeStart: 2, body: 'and this' },
      ],
    })
  })

  test('notes alone are enough to send', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })
    await session.sendNotes()

    expect(connection.prompts).toHaveLength(1)
    expect(session.state().transcript[0]).toMatchObject({
      kind: 'user',
      text: '',
      notes: [{ path: 'src/a.ts', line: 1, lineText: 'export const value = 2', body: 'why 2?' }],
    })
  })

  test('a note is sent once', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })
    await session.sendNotes()
    await session.sendNotes()

    expect(connection.prompts).toHaveLength(1)
  })

  test('a turn that fails puts its notes back, so they can be sent again', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'why 2?' })

    connection.failNextPrompt(new Error('Claude Code process terminated by signal SIGKILL'))
    await session.sendNotes()
    expect(session.state().annotations[0]?.sentAt).toBeNull()

    await session.sendNotes()
    expect(connection.prompts).toHaveLength(2)
    expect(connection.prompts[1]).toContain('why 2?')
    expect(session.state().annotations[0]?.sentAt).not.toBeNull()
  })

  test('nothing to send sends nothing', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.sendNotes('')

    expect(connection.prompts).toEqual([])
  })

  test('sent mid-turn, they go as the next turn — only the ones there when asked', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'first' })

    connection.hangNextPrompt()
    const turn = session.send('working')
    await until(() => session.state().status === 'working')

    await session.sendNotes('and fix this')
    await session.annotate({ ...NOTE, line: 5, rangeStart: 5, body: 'written after' })
    connection.releasePrompt()
    await turn
    await until(() => connection.prompts.length === 2 && session.state().status === 'idle')

    const second = connection.prompts[1] ?? ''
    expect(second).toContain('first')
    expect(second).toContain('and fix this')
    expect(second).not.toContain('written after')
    const [sent, kept] = [
      session.state().annotations.find((note) => note.body === 'first'),
      session.state().annotations.find((note) => note.body === 'written after'),
    ]
    expect(sent?.sentAt).not.toBeNull()
    expect(kept?.sentAt).toBeNull()
  })

  test('a note withdrawn before its turn does not go', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'changed my mind' })

    connection.hangNextPrompt()
    const turn = session.send('working')
    await until(() => session.state().status === 'working')
    await session.sendNotes()
    const id = session.state().annotations[0]?.id ?? ''
    await session.removeAnnotation(id)
    connection.releasePrompt()
    await turn
    await settle()

    expect(connection.prompts).toEqual(['working'])
  })

  test('belong to their session, and come back with it', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.annotate({ ...NOTE, body: 'on sess-1' })

    await session.newSession()
    expect(session.state().annotations).toEqual([])

    connection.setSessions([{ sessionId: 'sess-1', title: null, updatedAt: null }])
    await session.resumeSession('sess-1')
    expect(session.state().annotations.map((note) => note.body)).toEqual(['on sess-1'])
  })
})

describe('hidden files', () => {
  const A = { root: ROOT, path: 'src/a.ts' }
  const B = { root: ROOT, path: 'src/b.ts' }
  const FILES = { 'src/a.ts': 'export const value = 2\n', 'src/b.ts': 'export const b = 1\n' }

  test('hiding a file lists it, and showing it takes it back off', async () => {
    const { session, hidden } = harness({ files: FILES })
    await session.start()

    await session.hideFile(A)
    expect(session.state().hidden).toEqual([A])
    expect(hidden.entries).toHaveLength(1)

    await session.showFile(A)
    expect(session.state().hidden).toEqual([])
    expect(hidden.entries).toEqual([])
  })

  test('an agent edit to the file shows it again; one to another file does not', async () => {
    const { session, connection, hidden } = harness({ files: FILES })
    await session.start()
    await session.hideFile(A)
    await session.hideFile(B)

    await connection.write({ path: 'src/a.ts', oldText: 'value = 2', newText: 'value = 3' })
    await settle()

    expect(session.state().hidden).toEqual([B])
    expect(hidden.entries.map((entry) => entry.path)).toEqual(['src/b.ts'])
  })

  test('a change made through Bash shows it again too', async () => {
    const { session, connection, editTarget } = harness({ files: FILES })
    await session.start()
    await session.hideFile(A)

    editTarget.files['src/a.ts'] = 'export const value = 9\n'
    connection.emit({
      kind: 'tool',
      id: 't1',
      title: 'sed',
      toolKind: 'execute',
      status: 'completed',
    })
    await settle()

    expect(session.state().hidden).toEqual([])
  })

  test('a file outside the root is never hidden', async () => {
    const { session, hidden } = harness({ files: FILES })
    await session.start()
    await session.hideFile({ root: '/elsewhere', path: 'src/a.ts' })

    expect(session.state().hidden).toEqual([])
    expect(hidden.entries).toEqual([])
  })

  test('belong to their session, and come back with it', async () => {
    const { session, connection } = harness({ files: FILES })
    await session.start()
    await session.hideFile(A)

    await session.newSession()
    expect(session.state().hidden).toEqual([])

    connection.setSessions([{ sessionId: 'sess-1', title: null, updatedAt: null }])
    await session.resumeSession('sess-1')
    expect(session.state().hidden).toEqual([A])
  })
})

describe('the queue', () => {
  test('what is said mid-turn goes as the next turn', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.hangNextPrompt()
    const turn = session.send('first')
    await until(() => session.state().status === 'working')
    session.queue('also this')
    expect(session.state().queued.map((message) => message.text)).toEqual(['also this'])

    connection.releasePrompt()
    await turn
    await until(() => connection.prompts.length === 2 && session.state().status === 'idle')

    expect(connection.prompts[1]).toContain('also this')
    expect(session.state().queued).toEqual([])
  })

  test('a withdrawn message never goes', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.hangNextPrompt()
    const turn = session.send('first')
    await until(() => session.state().status === 'working')
    session.queue('regret')
    session.unqueue(session.state().queued[0]?.id ?? '')
    connection.releasePrompt()
    await turn
    await settle()

    expect(connection.prompts).toEqual(['first'])
  })

  test('with nothing running, it goes straight away', async () => {
    const { session, connection } = harness()
    await session.start()
    session.queue('now')
    await until(() => connection.prompts.length === 1 && session.state().status === 'idle')

    expect(connection.prompts[0]).toContain('now')
  })
})

describe('sessions', () => {
  test('switching is refused mid-turn', async () => {
    const { session, connection } = harness()
    await session.start()
    connection.hangNextPrompt()
    const turn = session.send('go')
    await until(() => session.state().status === 'working')

    await expect(session.newSession()).rejects.toThrow()
    connection.releasePrompt()
    await turn
  })

  test('a new session starts clean', async () => {
    const { session } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.send('go')
    session.queue('x')

    await session.newSession()
    expect(session.state().sessionId).toBe('sess-2')
    expect(session.state().queued).toEqual([])
    expect(session.state().transcript.map((entry) => entry.kind)).toEqual(['notice'])
  })

  test('a resume replays the conversation and measures from its own baseline', async () => {
    const { session, connection, roots } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()
    await session.resumeSession('old-1')

    expect(connection.loaded).toEqual(['old-1'])
    expect(session.state().sessionId).toBe('old-1')
    expect(roots.activations.at(-1)).toBe('old-1')
    // Cumulative: the resumed session's board is everything since its own start, not empty.
    expect(session.state().chunks.map((chunk) => chunk.path)).toEqual(['src/a.ts'])
  })

  /**
   * Resuming into a plan nobody answered.
   *
   * The session died with the plan on the table, so there is no `canUseTool` call left to
   * return a decision to — it has to reach the agent as the next thing said to it instead.
   */
  test('a plan nobody answered comes back as a decision, and approving it tells the agent', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '# The Plan', round: 1, outcome: 'standing' })
    expect(session.state().planReview).toMatchObject({ plan: '# The Plan', recovered: true })
    // Not filed as history: nothing was decided, so there is nothing to record yet.
    expect(session.state().transcript.some((entry) => entry.kind === 'plan')).toBe(false)

    session.approvePlan()
    await Bun.sleep(60)

    expect(session.state().planReview).toBeNull()
    expect(session.state().planMode).toBe('default')
    expect(session.state().transcript.find((entry) => entry.kind === 'plan')).toMatchObject({
      outcome: 'approved',
    })
    expect(connection.prompts).toHaveLength(1)
    expect(connection.prompts[0]).toContain('approved')
  })

  test('sending a recovered plan back reaches the agent as its next instruction', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '1. do this', round: 1, outcome: 'standing' })
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: '1. do this', body: 'not that' })
    session.rejectPlan('start over')
    await Bun.sleep(60)

    expect(session.state().planReview).toBeNull()
    const sent = connection.prompts.at(-1) ?? ''
    expect(sent).toContain('not that')
    expect(sent).toContain('start over')
    expect(session.state().transcript.find((entry) => entry.kind === 'plan')).toMatchObject({
      outcome: 'sent-back',
    })
  })

  /**
   * What the reader is shown is not what the agent is told.
   *
   * The refusal handed over is composed — it quotes every note and explains itself — and that
   * is right for the agent and wrong for the conversation, where it appeared as a message the
   * reader never wrote. Notes have always been kept apart from the words typed beside them;
   * this is the same separation.
   */
  test('sending a plan back shows what you wrote, not what was composed for the agent', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '1. do this', round: 1, outcome: 'standing' })
    session.annotatePlan({
      rangeStart: 2,
      line: 3,
      lineText: 'backend/Dockerfile',
      body: 'can you use a hardened image',
    })
    session.rejectPlan('otherwise fine')
    await Bun.sleep(60)

    const said = connection.prompts.at(-1) ?? ''
    expect(said).toContain('The human did not accept this plan')
    expect(said).toContain('can you use a hardened image')

    const bubble = session.state().transcript.findLast((entry) => entry.kind === 'user')
    expect(bubble).toMatchObject({ kind: 'user', text: 'otherwise fine' })
    // The composed preamble is for the agent alone.
    expect(bubble?.kind === 'user' && bubble.text).not.toContain('The human did not accept')
    expect(bubble?.kind === 'user' && bubble.notes).toEqual([
      {
        path: PLAN_PATH,
        line: 3,
        rangeStart: 2,
        side: 'new',
        lineText: 'backend/Dockerfile',
        body: 'can you use a hardened image',
      },
    ])
  })

  test('sending a plan back with only notes writes no words into your mouth', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '1. do this', round: 1, outcome: 'standing' })
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: '1. do this', body: 'not that' })
    session.rejectPlan('')
    await Bun.sleep(60)

    const bubble = session.state().transcript.findLast((entry) => entry.kind === 'user')
    expect(bubble).toMatchObject({ kind: 'user', text: '' })
    expect(bubble?.kind === 'user' && bubble.notes).toHaveLength(1)
  })

  test('approving a recovered plan puts no message in the conversation at all', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '# The Plan', round: 1, outcome: 'standing' })
    session.approvePlan()
    await Bun.sleep(60)

    // Approving is a click, not a sentence. The plan's own record says what happened.
    expect(session.state().transcript.some((entry) => entry.kind === 'user')).toBe(false)
    expect(session.state().transcript.find((entry) => entry.kind === 'plan')).toMatchObject({
      outcome: 'approved',
    })
    expect(connection.prompts).toHaveLength(1)
  })

  test('a plan that was decided is replayed as a record, not as a decision', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.emit({ kind: 'plan', text: '# Done', round: 1, outcome: 'approved' })
    expect(session.state().planReview).toBeNull()
    expect(session.state().transcript.find((entry) => entry.kind === 'plan')).toMatchObject({
      outcome: 'approved',
    })
  })

  test('a pending plan does not follow the reader into a resumed session', async () => {
    const { session, connection } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()

    // `newSession` cleared this through `prepareSession`; a resume did not, so an unanswerable
    // plan followed the reader across and pinned itself to the new session's tab strip.
    const abandoned = connection.requestPlanApproval('the plan')
    expect(session.state().planReview).not.toBeNull()

    await session.resumeSession('old-1')
    expect(session.state().planReview).toBeNull()
    expect((await abandoned).decision).toBe('reject')
  })

  test('switching sessions tells the diff pane to refetch', async () => {
    const { session } = harness({ deltas: [delta('src/a.ts')] })
    await session.start()

    const before = session.state().diffRevision
    await session.resumeSession('old-1')
    const afterResume = session.state().diffRevision
    expect(afterResume).toBeGreaterThan(before)

    await session.newSession()
    expect(session.state().diffRevision).toBeGreaterThan(afterResume)
  })

  test('only sessions with a recorded baseline are listed', async () => {
    const { session, connection } = harness()
    await session.start()
    connection.setSessions([
      { sessionId: 'sess-1', title: 'mine', updatedAt: '2026-01-02' },
      { sessionId: 'stray', title: 'a plain claude session', updatedAt: '2026-01-03' },
    ])

    expect((await session.listSessions()).map((summary) => summary.sessionId)).toEqual(['sess-1'])
  })
})

describe('plan mode and prompts from the agent', () => {
  test('plan mode switches the agent, and is refused mid-turn', async () => {
    const { session, connection } = harness()
    await session.start()
    await session.enterPlanMode()
    expect(session.state().planMode).toBe('plan')
    expect(connection.permissionModes).toEqual(['plan'])

    connection.hangNextPrompt()
    const turn = session.send('go')
    await until(() => session.state().status === 'working')
    await expect(session.exitPlanMode()).rejects.toThrow()
    connection.releasePrompt()
    await turn
  })

  test('a submitted plan waits for a decision', async () => {
    const { session, connection } = harness()
    await session.start()

    const approved = connection.requestPlanApproval('the plan')
    expect(session.state().planReview).toEqual({
      plan: 'the plan',
      round: 1,
      notes: [],
      recovered: false,
    })
    session.approvePlan()
    expect(await approved).toEqual({ decision: 'allow' })
    expect(session.state().planReview).toBeNull()

    const rejected = connection.requestPlanApproval('another')
    session.rejectPlan('not that')
    const outcome = await rejected
    expect(outcome.decision).toBe('reject')
    const reasoning = outcome.decision === 'reject' ? outcome.reasoning : ''
    expect(reasoning).toContain('not that')
    // And says what to do about it — see `planRefusal`.
    expect(reasoning).toContain('ExitPlanMode')
  })

  test('each submitted plan is a new round', async () => {
    const { session, connection } = harness()
    await session.start()

    // The round used to be read back off `state.planReview`, which `requestPlanApproval` clears
    // before it returns — so the revised plan always arrived to find nothing to count from and
    // every round called itself the first.
    const first = connection.requestPlanApproval('the plan')
    expect(session.state().planReview?.round).toBe(1)
    session.rejectPlan('not that')
    await first

    connection.requestPlanApproval('a better plan')
    expect(session.state().planReview?.round).toBe(2)
  })

  test('notes on a plan go back as the reason it was refused', async () => {
    const { session, connection } = harness()
    await session.start()

    const rejected = connection.requestPlanApproval('1. do this\n2. do that')
    session.annotatePlan({ rangeStart: 2, line: 2, lineText: '2. do that', body: 'not that bit' })
    expect(session.state().planReview?.notes).toHaveLength(1)

    session.rejectPlan('otherwise fine')
    const result = await rejected
    expect(result.decision).toBe('reject')
    const reasoning = result.decision === 'reject' ? result.reasoning : ''
    expect(reasoning).toContain('line 2 — not that bit')
    expect(reasoning).toContain('> 2. do that')
    expect(reasoning).toContain('otherwise fine')
  })

  test('a refusal with neither a note nor a message is not sent', async () => {
    const { session, connection } = harness()
    await session.start()

    const rejected = connection.requestPlanApproval('the plan')
    session.rejectPlan('   ')
    // Still pending: a refusal the agent cannot act on would burn a round to say nothing.
    expect(session.state().planReview).not.toBeNull()

    // A note is a reason on its own, so this one does go.
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: 'the plan', body: 'no' })
    session.rejectPlan('')
    await rejected
    expect(session.state().planReview).toBeNull()
  })

  test('a new round starts with no notes, and notes need a pending plan', async () => {
    const { session, connection } = harness()
    await session.start()

    const first = connection.requestPlanApproval('the plan')
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: 'the plan', body: 'no' })
    session.rejectPlan('')
    await first

    // Nothing pending: a note has nowhere to go rather than somewhere wrong.
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: 'x', body: 'stray' })
    expect(session.state().planReview).toBeNull()

    connection.requestPlanApproval('a better plan')
    expect(session.state().planReview?.notes).toEqual([])
  })

  test('a plan note can be withdrawn', async () => {
    const { session, connection } = harness()
    await session.start()

    connection.requestPlanApproval('the plan')
    session.annotatePlan({ rangeStart: 1, line: 1, lineText: 'the plan', body: 'no' })
    const id = session.state().planReview?.notes[0]?.id ?? ''
    expect(id).not.toBe('')

    session.removePlanNote(id)
    expect(session.state().planReview?.notes).toEqual([])
  })

  test('a decided plan is kept in the conversation', async () => {
    const { session, connection } = harness()
    await session.start()

    // The plan tab is transient, so without this approving a plan erased the thing that had
    // just been agreed to.
    const approved = connection.requestPlanApproval('# The Plan\n\n1. Do the thing.')
    session.approvePlan()
    await approved

    const entry = session.state().transcript.find((item) => item.kind === 'plan')
    expect(entry).toMatchObject({
      kind: 'plan',
      text: '# The Plan\n\n1. Do the thing.',
      round: 1,
      outcome: 'approved',
    })
  })

  test('a plan sent back is kept too, marked as what it was', async () => {
    const { session, connection } = harness()
    await session.start()

    const rejected = connection.requestPlanApproval('first try')
    session.rejectPlan('not that')
    await rejected

    expect(session.state().transcript.find((item) => item.kind === 'plan')).toMatchObject({
      outcome: 'sent-back',
      round: 1,
    })
  })

  test('cancelling a turn settles a plan nobody is listening for', async () => {
    const { session, connection } = harness()
    await session.start()

    // An interrupt does not settle a `canUseTool` call already in flight, so without this the
    // plan stays pinned to the strip with nothing behind it to answer.
    const rejected = connection.requestPlanApproval('the plan')
    await session.cancel()

    expect(session.state().planReview).toBeNull()
    expect((await rejected).decision).toBe('reject')
  })

  test('permissions are listed until answered', async () => {
    const { session, connection } = harness()
    await session.start()
    connection.emit({
      kind: 'permission',
      id: 'p1',
      title: 'rm',
      subject: null,
      description: null,
      reason: null,
      options: [],
    })
    expect(session.state().permissions.map((p) => p.id)).toEqual(['p1'])

    session.answerPermission('p1', 'allow')
    connection.emit({ kind: 'permission-resolved', id: 'p1' })
    expect(connection.answered).toEqual([{ id: 'p1', optionId: 'allow' }])
    expect(session.state().permissions).toEqual([])
  })
})

/**
 * The reader editing the file they are reading — their own checkout, their own change. It
 * shares the agent's aftermath (the board, the review, note staleness) and none of its gating:
 * `runToolWrite` exists to hold the *agent* to `old_text` and to the repository, and a human
 * typing in their own file needs neither.
 */
describe('editing a file yourself', () => {
  const FILE = 'export const value = 2\nexport const other = 9\n'

  test('writes it to disk', async () => {
    const { session, editTarget } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()

    await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'export const value = 3\n')

    expect(editTarget.files['src/a.ts']).toBe('export const value = 3\n')
  })

  test('tells the board the tree moved', async () => {
    const { session } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()
    const before = session.state().diffRevision

    await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'export const value = 3\n')

    expect(session.state().diffRevision).toBeGreaterThan(before)
  })

  test('says so when it lands', async () => {
    const { session } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()

    expect(await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'next')).toEqual({ ok: true })
  })

  /**
   * A refusal has to be reported, not swallowed. The caller clears its unsaved-changes
   * marker on a successful save, so a save that silently does nothing tells the reader their
   * work is on disk when it is not — the worst failure shape this tool can have.
   */
  test('refuses a root this session knows nothing about, and says why', async () => {
    const { session, editTarget } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()

    const result = await session.saveFile(
      { root: '/somewhere/else', path: 'src/a.ts' },
      'clobbered',
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('/somewhere/else')
    expect(editTarget.files['src/a.ts']).toBe(FILE)
  })

  test('reports a write that fails rather than claiming it saved', async () => {
    const { session, editTarget } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()
    editTarget.write = async () => {
      throw new Error('read-only file system')
    }

    const result = await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'next')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('read-only file system')
  })

  test('leaves a note alone when the edit is to other lines', async () => {
    const { session } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()
    await session.annotate({ ...NOTE, body: 'about line 1' })

    await session.saveFile(
      { root: ROOT, path: 'src/a.ts' },
      'export const value = 2\nexport const other = 10\n',
    )
    await settle()

    expect(session.state().annotations.map((note) => note.body)).toEqual(['about line 1'])
  })

  test('clears a note when the edit is to the lines it is about', async () => {
    const { session } = harness({ files: { 'src/a.ts': FILE } })
    await session.start()
    await session.annotate({ ...NOTE, body: 'about line 1' })

    await session.saveFile(
      { root: ROOT, path: 'src/a.ts' },
      'export const value = 3\nexport const other = 9\n',
    )
    await settle()

    expect(session.state().annotations).toEqual([])
  })
})

/**
 * What a session reports about itself.
 *
 * Counters rather than spans for the lifecycle, deliberately: the agent SDK opens one
 * long-lived `query()` per session and inherits any span active at that moment as the parent of
 * every turn it will ever run, so a span around the session's opening would collect hours of
 * agent work under one short bar. Correlation happens on `session.id` instead — see
 * `adapters/otel/telemetry.ts`.
 */
describe('what a session measures', () => {
  const FILE = 'export const value = 2\nexport const other = 9\n'

  test('counts the reader s own save, tagged as the human s', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'export const value = 3\n')

    expect(telemetry.totalCounted('turnstile.files.saved', { actor: 'human', outcome: 'ok' })).toBe(
      1,
    )
  })

  /** A refusal is the interesting half: it is the case that used to fail silently. */
  test('counts a refused save as refused, not as a save', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.saveFile({ root: '/somewhere/else', path: 'src/a.ts' }, 'clobbered')

    expect(
      telemetry.totalCounted('turnstile.files.saved', { actor: 'human', outcome: 'refused' }),
    ).toBe(1)
    expect(telemetry.totalCounted('turnstile.files.saved', { actor: 'human', outcome: 'ok' })).toBe(
      0,
    )
  })

  test('counts a write that threw as failed', async () => {
    const telemetry = recordingTelemetry()
    const { session, editTarget } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()
    editTarget.write = async () => {
      throw new Error('read-only file system')
    }

    await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'next')

    expect(
      telemetry.totalCounted('turnstile.files.saved', { actor: 'human', outcome: 'failed' }),
    ).toBe(1)
  })

  /** Telling the agent's writes from the reader's is the point of tagging an actor at all. */
  test('counts the agent s write separately from the reader s', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.writeFile({
      path: 'src/a.ts',
      oldText: FILE,
      newText: 'export const value = 9\n',
    })

    expect(telemetry.totalCounted('turnstile.files.saved', { actor: 'agent', outcome: 'ok' })).toBe(
      1,
    )
    expect(telemetry.totalCounted('turnstile.files.saved', { actor: 'human' })).toBe(0)
  })

  test('counts a write the agent was refused', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.writeFile({
      path: 'src/a.ts',
      oldText: 'text that is not in the file',
      newText: 'whatever',
    })

    expect(
      telemetry.totalCounted('turnstile.files.saved', { actor: 'agent', outcome: 'refused' }),
    ).toBe(1)
  })

  test('counts how many notes a send actually delivered', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()
    await session.annotate({ ...NOTE, body: 'one' })
    await session.annotate({ ...NOTE, body: 'two' })

    await session.sendNotes()

    expect(telemetry.totalCounted('turnstile.notes.sent')).toBe(2)
  })

  test('counts nothing when a send carries no notes', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.send('just a message')

    expect(telemetry.totalCounted('turnstile.notes.sent')).toBe(0)
  })

  /**
   * The attribute that makes Turnstile's measurements and the agent's one picture: the CLI
   * stamps `session.id` on its own spans, so this is what a backend joins on.
   */
  test('stamps the session id on everything it measures', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()
    const id = session.state().sessionId
    expect(id).not.toBe('')

    await session.saveFile({ root: ROOT, path: 'src/a.ts' }, 'next')
    await session.diff()

    expect(telemetry.counts[0]?.attrs['session.id']).toBe(id)
    expect(telemetry.spansNamed('turnstile.diff')[0]?.attrs['session.id']).toBe(id)
  })

  test('times building the diff view', async () => {
    const telemetry = recordingTelemetry()
    const { session } = harness({ files: { 'src/a.ts': FILE }, telemetry })
    await session.start()

    await session.diff()

    expect(telemetry.spansNamed('turnstile.diff')).toHaveLength(1)
  })
})
