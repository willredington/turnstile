import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { serveApp } from '../../../src/adapters/web/server.ts'
import { createAutoMode } from '../../../src/app/autoMode.ts'
import { PLAN_PATH } from '../../../src/core/annotations.ts'
import type { AutoModePolicy } from '../../../src/core/autoMode.ts'
import type {
  Asker,
  AskRequest,
  ProjectTree,
  RepoReader,
  RootHandle,
  RootRegistry,
  Session,
} from '../../../src/core/ports.ts'
import type { Annotation, SessionState } from '../../../src/core/types.ts'
import { type RecordingTelemetry, recordingTelemetry } from '../../support/telemetry.ts'

/** The real `serveApp`, bound to an ephemeral port, hit with a real `fetch`. */

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    state: () => {
      throw new Error('not used')
    },
    diff: async () => {
      throw new Error('not used')
    },
    start: async () => {},
    initRepository: async () => {},
    newSession: async () => {},
    resumeSession: async () => {},
    listSessions: async () => [],
    send: async () => {},
    sendNotes: async () => {},
    answerPermission: () => {},
    answerQuestion: () => {},
    queue: () => {},
    unqueue: () => {},
    annotate: async () => {},
    removeAnnotation: async () => {},
    saveFile: async () => ({ ok: true as const }),
    reviewNow: () => {},
    hideFile: async () => {},
    showFile: async () => {},
    enterPlanMode: async () => {},
    exitPlanMode: async () => {},
    approvePlan: () => {},
    rejectPlan: () => {},
    annotatePlan: () => {},
    removePlanNote: () => {},
    cancel: async () => {},
    stop: () => {},
    writeFile: async () => ({ decision: 'allow', fileContent: '' }),
    ...overrides,
  }
}

const fakeProjectTree: ProjectTree = { list: async () => [], read: async () => null }

/** An asker that answers whatever it is asked, recording the request the route built for it. */
const askCalls: AskRequest[] = []
const fakeAsker: Asker = {
  ask: async (input) => {
    askCalls.push(input)
    return 'Because of the tab rows.'
  },
}

const fakeReader: RepoReader = {
  read: async () => null,
  glob: async () => ({ paths: [], truncated: false }),
  grep: async () => ({ matches: [], truncated: false }),
}

/** A `ProjectTree` whose listing/content differs by root, for the `/files` root-param tests. */
function multiRootProjectTree(
  byRoot: Record<string, { files: string[]; content: Record<string, string>; binary?: string[] }>,
): ProjectTree {
  return {
    list: async (root) => byRoot[root]?.files ?? [],
    read: async (root, path) => {
      const entry = byRoot[root]
      if (entry === undefined) return null
      if (entry.binary?.includes(path) === true) return { kind: 'binary' }
      const text = entry.content[path]
      return text === undefined ? null : { kind: 'text', text }
    },
  }
}

function fakeRootHandle(root: string): RootHandle {
  return {
    root,
    snapshots: {
      capture: async () => 'sim',
      delta: async () => [],
      patch: async () => '',
      contents: async () => null,
    },
    baseline: {
      resolve: async () => ({ tree: 'sim', source: 'session-start', branch: null }),
    },
  }
}

function fakeRootRegistry(roots: RootHandle[]): RootRegistry {
  return {
    knownRoots: () => roots,
    activate: (root) => roots.find((handle) => handle.root === root) ?? fakeRootHandle(root),
    deactivate: () => {},
    rootFor: (absolutePath) =>
      roots.find(
        (handle) => absolutePath === handle.root || absolutePath.startsWith(`${handle.root}/`),
      ) ?? null,
    teardown: async () => {},
  }
}

const ONE_ROOT = fakeRootRegistry([fakeRootHandle('/repo')])

const SOME_STATE: SessionState = {
  status: 'idle',
  fileFindings: [],
  sessionId: 'sess-1',
  transcript: [],
  permissions: [],
  questions: [],
  revision: 1,
  diffRevision: 0,
  chunks: [],
  roots: [],
  annotations: [],
  hidden: [],
  queued: [],
  model: 'Claude Sonnet 5',
  thinkingLevel: 'high',
  contextUsed: 1200,
  contextSize: 200000,
  planMode: 'default',
  planReview: null,
  review: null,
  tracking: 'git',
  baseline: null,
}

describe('/state', () => {
  test('includes the project cwd, abbreviated under the home directory', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}state`)
      const payload = (await response.json()) as { cwd: string }
      expect(payload.cwd).toBe('~/projects/turnstile')
    } finally {
      server.stop()
    }
  })
})

describe('/notes/send', () => {
  /** Resolves only when the test says so — standing in for a turn that runs for minutes. */
  function heldSendNotes() {
    const calls: (string | undefined)[] = []
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      calls,
      release,
      sendNotes: async (text?: string) => {
        calls.push(text)
        await held
      },
    }
  }

  test('hands the trimmed text to sendNotes, without waiting for the turn', async () => {
    const notes = heldSendNotes()
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE, sendNotes: notes.sendNotes }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}notes/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '  and add a test  ' }),
      })
      expect(response.status).toBe(200)
      expect(notes.calls).toEqual(['and add a test'])
    } finally {
      notes.release()
      server.stop()
    }
  })

  /** Sending notes alone is the ordinary case: the text is optional. */
  test('sends the notes with no text when none is given', async () => {
    const notes = heldSendNotes()
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE, sendNotes: notes.sendNotes }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}notes/send`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(notes.calls).toEqual([''])
    } finally {
      notes.release()
      server.stop()
    }
  })
})

describe('/annotate', () => {
  type AnnotateInput = Parameters<Session['annotate']>[0]

  async function annotate(payload: unknown, roots: RootRegistry = ONE_ROOT) {
    const calls: AnnotateInput[] = []
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        annotate: async (input) => {
          calls.push(input)
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}annotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, calls }
    } finally {
      server.stop()
    }
  }

  test('forwards a line-anchored note, range included', async () => {
    const { status, calls } = await annotate({
      root: '/repo',
      path: 'src/a.ts',
      line: 12,
      rangeStart: 10,
      side: 'old',
      lineText: 'const a = 1',
      body: '  why was this removed?  ',
    })
    expect(status).toBe(200)
    expect(calls).toEqual([
      {
        root: '/repo',
        path: 'src/a.ts',
        line: 12,
        rangeStart: 10,
        side: 'old',
        lineText: 'const a = 1',
        body: 'why was this removed?',
      },
    ])
  })

  test('defaults root to the active root, side to new, and leaves rangeStart to the session', async () => {
    const { status, calls } = await annotate({ path: 'src/a.ts', line: 3, body: 'rename this' })
    expect(status).toBe(200)
    expect(calls).toEqual([
      {
        root: '/repo',
        path: 'src/a.ts',
        line: 3,
        rangeStart: undefined,
        side: 'new',
        lineText: '',
        body: 'rename this',
      },
    ])
  })

  test('refuses a note missing its path, line or body', async () => {
    for (const payload of [
      { line: 3, body: 'x' },
      { path: 'src/a.ts', body: 'x' },
      { path: 'src/a.ts', line: '3', body: 'x' },
      { path: 'src/a.ts', line: 3, body: '   ' },
    ]) {
      const { status, calls } = await annotate(payload)
      expect(status).toBe(400)
      expect(calls).toEqual([])
    }
  })

  test('refuses a note with no root to anchor it before a session has one', async () => {
    const { status, calls } = await annotate(
      { path: 'src/a.ts', line: 3, body: 'x' },
      fakeRootRegistry([]),
    )
    expect(status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe('/file/hide and /file/show', () => {
  async function post(route: 'hide' | 'show', payload: unknown) {
    const calls: { route: string; root: string; path: string }[] = []
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        hideFile: async (file) => {
          calls.push({ route: 'hide', ...file })
        },
        showFile: async (file) => {
          calls.push({ route: 'show', ...file })
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}file/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, calls }
    } finally {
      server.stop()
    }
  }

  test('forwards the file to hide or show', async () => {
    const hidden = await post('hide', { root: '/repo', path: 'src/a.ts' })
    expect(hidden.status).toBe(200)
    expect(hidden.calls).toEqual([{ route: 'hide', root: '/repo', path: 'src/a.ts' }])

    const shown = await post('show', { root: '/repo', path: 'src/a.ts' })
    expect(shown.status).toBe(200)
    expect(shown.calls).toEqual([{ route: 'show', root: '/repo', path: 'src/a.ts' }])
  })

  test('refuses a body missing its root or path', async () => {
    for (const route of ['hide', 'show'] as const) {
      for (const payload of [{ path: 'src/a.ts' }, { root: '/repo' }, { root: '/repo', path: 3 }]) {
        const { status, calls } = await post(route, payload)
        expect(status).toBe(400)
        expect(calls).toEqual([])
      }
    }
  })
})

describe('/question', () => {
  test('forwards id and answers to the session', async () => {
    const calls: { id: string; answers: Record<string, string | string[]> }[] = []
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        answerQuestion: (id, answers) => calls.push({ id, answers }),
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'q1',
          answers: { 'Which format?': 'Summary', 'Which sections?': ['Intro', 'Conclusion'] },
        }),
      })
      expect(response.status).toBe(200)
      expect(calls).toEqual([
        {
          id: 'q1',
          answers: { 'Which format?': 'Summary', 'Which sections?': ['Intro', 'Conclusion'] },
        },
      ])
    } finally {
      server.stop()
    }
  })

  test('rejects a body whose answers are not strings or string arrays', async () => {
    const calls: unknown[] = []
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        answerQuestion: (...args) => calls.push(args),
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'q1', answers: { 'Which format?': 42 } }),
      })
      expect(response.status).toBe(400)
      expect(calls).toEqual([])
    } finally {
      server.stop()
    }
  })
})

describe('/files', () => {
  const twoRoots = fakeRootRegistry([fakeRootHandle('/repoA'), fakeRootHandle('/repoB')])
  const projectTree = multiRootProjectTree({
    '/repoA': {
      files: ['a.ts', 'doc.pdf'],
      content: { 'a.ts': 'from A' },
      binary: ['doc.pdf'],
    },
    '/repoB': { files: ['b.ts'], content: { 'b.ts': 'from B' } },
  })

  /**
   * A binary file is answered, not refused: it exists and it is readable, it just has no text
   * to send. The bytes never go over the wire — rendering them line by line is what froze the
   * app on a PDF in the first place.
   */
  test('a binary file answers as binary, with no text', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: twoRoots,
      cwd: '/repoA',
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}files/content?path=doc.pdf`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ binary: true })
    } finally {
      server.stop()
    }
  })

  test('defaults to the primary root when none is named', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: twoRoots,
      cwd: '/repoA',
      port: 0,
    })
    try {
      const files = await (await fetch(`${server.url}files`)).json()
      expect(files).toEqual(['a.ts', 'doc.pdf'])

      const content = await (await fetch(`${server.url}files/content?path=a.ts`)).json()
      expect(content).toEqual({ text: 'from A' })
    } finally {
      server.stop()
    }
  })

  /**
   * Before a session opens there is no root, and the answer used to be the
   * process's own cwd — the human's checkout, which is a different set of files from the one
   * the agent can see. That is how a file got browsed, opened and read, and then denied by the
   * agent: both truthful, about different directories.
   */
  test('serves the launch directory before a session has a root', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: fakeRootRegistry([]),
      cwd: '/repoA',
      port: 0,
    })
    try {
      expect(await (await fetch(`${server.url}files`)).json()).toEqual(['a.ts', 'doc.pdf'])

      const content = await fetch(`${server.url}files/content?path=a.ts`)
      expect(await content.json()).toEqual({ text: 'from A' })
    } finally {
      server.stop()
    }
  })

  test('an explicit ?root= targets that root instead', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: twoRoots,
      cwd: '/repoA',
      port: 0,
    })
    try {
      const files = await (await fetch(`${server.url}files?root=/repoB`)).json()
      expect(files).toEqual(['b.ts'])

      const content = await (await fetch(`${server.url}files/content?root=/repoB&path=b.ts`)).json()
      expect(content).toEqual({ text: 'from B' })
    } finally {
      server.stop()
    }
  })
})

describe('/plan-mode', () => {
  test('"plan" calls enterPlanMode, "default" calls exitPlanMode', async () => {
    const calls: string[] = []
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        enterPlanMode: async () => {
          calls.push('enter')
        },
        exitPlanMode: async () => {
          calls.push('exit')
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const enterResponse = await fetch(`${server.url}plan-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      })
      expect(enterResponse.status).toBe(200)

      const exitResponse = await fetch(`${server.url}plan-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'default' }),
      })
      expect(exitResponse.status).toBe(200)

      expect(calls).toEqual(['enter', 'exit'])
    } finally {
      server.stop()
    }
  })

  test('an invalid mode is rejected with 400', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}plan-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'bogus' }),
      })
      expect(response.status).toBe(400)
    } finally {
      server.stop()
    }
  })

  test('the session refusing mid-turn surfaces as 409, not a bare 500', async () => {
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        enterPlanMode: async () => {
          throw new Error('cannot change plan mode while a turn is in progress or a review is open')
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}plan-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      })
      expect(response.status).toBe(409)
    } finally {
      server.stop()
    }
  })
})

describe('/review', () => {
  test('asks the session to review, and answers at once', async () => {
    let asked = 0
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        reviewNow: () => {
          asked += 1
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}review`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(asked).toBe(1)
    } finally {
      server.stop()
    }
  })
})

describe('/auto-mode', () => {
  const policy: AutoModePolicy = {
    version: 1,
    threshold: 0.3,
    rules: [{ id: 'push', text: 'Pushes to a remote' }],
  }

  const send = (url: string, route: string, payload: unknown) =>
    fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

  async function serveWithAutoMode() {
    let saved: AutoModePolicy | null = null
    const autoMode = createAutoMode({
      store: {
        load: async () => saved,
        save: async (next) => {
          saved = next
        },
      },
      judge: {
        judge: async (state, rules) =>
          new Map(
            rules.map((rule) => [rule.id, String(state.call.command).includes('push') ? 0.9 : 0.1]),
          ),
      },
      where: { cwd: '/repo', home: '/home/me' },
      timeoutMs: 1_000,
    })
    await autoMode.load()
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: '/repo',
      port: 0,
      autoMode,
    })
    return { server, saved: () => saved }
  }

  test('starts with no policy and offers the seeds', async () => {
    const { server } = await serveWithAutoMode()
    try {
      const settings = await (await fetch(`${server.url}auto-mode`)).json()
      expect(settings.policy).toBeNull()
      expect(settings.seeds.length).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  })

  test('saves a valid policy and refuses anything else', async () => {
    const { server, saved } = await serveWithAutoMode()
    try {
      const put = (body: unknown) =>
        fetch(`${server.url}auto-mode`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await put({ ...policy, threshold: 7 })).status).toBe(400)
      expect(saved()).toBeNull()

      const response = await put(policy)
      expect(response.status).toBe(200)
      expect((await response.json()).policy).toEqual(policy)
      expect(saved()).toEqual(policy)
    } finally {
      server.stop()
    }
  })

  test('a trial judges a command against the statements sent, saved or not', async () => {
    const { server, saved } = await serveWithAutoMode()
    try {
      const trial = await (
        await send(server.url, 'auto-mode/trial', { command: 'git push', policy })
      ).json()
      expect(trial.verdict.kind).toBe('flag')
      expect(trial.probabilities).toEqual([{ id: 'push', probability: 0.9 }])
      expect(saved()).toBeNull()

      expect((await send(server.url, 'auto-mode/trial', { command: '', policy })).status).toBe(400)
    } finally {
      server.stop()
    }
  })

  test('without auto-mode, the routes are not there', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: '/repo',
      port: 0,
    })
    try {
      expect((await fetch(`${server.url}auto-mode`)).status).toBe(404)
    } finally {
      server.stop()
    }
  })
})

describe('/repo/init', () => {
  test('initializes the repository and awaits it before responding', async () => {
    let initialized = 0
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        initRepository: async () => {
          initialized += 1
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}repo/init`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(initialized).toBe(1)
    } finally {
      server.stop()
    }
  })

  test('reports a failed initialization with its reason', async () => {
    const server = serveApp({
      session: fakeSession({
        state: () => SOME_STATE,
        initRepository: async () => {
          throw new Error('git init failed')
        },
      }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}repo/init`, { method: 'POST' })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'git init failed' })
    } finally {
      server.stop()
    }
  })
})

describe('/plan-review', () => {
  /** A session with a plan on the table, since every rule in the route reads one. */
  const pending = (notes: Annotation[] = []): SessionState => ({
    ...SOME_STATE,
    planReview: { plan: '1. do this\n2. do that', round: 2, notes, recovered: false },
  })

  const planNote = (overrides: Partial<Annotation> = {}): Annotation => ({
    id: 'n1',
    sessionId: 's1',
    root: '',
    path: PLAN_PATH,
    line: 2,
    rangeStart: 2,
    side: 'new',
    lineText: '2. do that',
    body: 'not that bit',
    at: new Date().toISOString(),
    sentAt: null,
    ...overrides,
  })

  const serve = (session: Session) =>
    serveApp({
      session,
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })

  const send = (url: string, route: string, payload: unknown) =>
    fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

  test('approve calls approvePlan with no body required', async () => {
    let approved = false
    const server = serve(
      fakeSession({
        state: () => pending(),
        approvePlan: () => {
          approved = true
        },
      }),
    )
    try {
      const response = await send(server.url, 'plan-review', { decision: 'approve' })
      expect(response.status).toBe(200)
      expect(approved).toBe(true)
    } finally {
      server.stop()
    }
  })

  test('approving over notes is refused, not silently dropped', async () => {
    let approved = false
    const server = serve(
      fakeSession({
        state: () => pending([planNote()]),
        approvePlan: () => {
          approved = true
        },
      }),
    )
    try {
      // The page disables the button, but it can be a round behind — a laggy socket, or a
      // second tab on the same session — and approving would destroy a written note.
      const response = await send(server.url, 'plan-review', { decision: 'approve' })
      expect(response.status).toBe(409)
      expect(approved).toBe(false)
    } finally {
      server.stop()
    }
  })

  test('a decision with no plan pending is refused', async () => {
    const server = serve(fakeSession({ state: () => SOME_STATE }))
    try {
      const response = await send(server.url, 'plan-review', { decision: 'approve' })
      expect(response.status).toBe(409)
    } finally {
      server.stop()
    }
  })

  test('reject forwards the trimmed feedback to rejectPlan', async () => {
    const feedback: string[] = []
    const server = serve(
      fakeSession({ state: () => pending(), rejectPlan: (text) => feedback.push(text) }),
    )
    try {
      const response = await send(server.url, 'plan-review', {
        decision: 'reject',
        feedback: '  add a step for tests  ',
      })
      expect(response.status).toBe(200)
      expect(feedback).toEqual(['add a step for tests'])
    } finally {
      server.stop()
    }
  })

  test('rejecting with neither a note nor feedback is refused with 400', async () => {
    const feedback: string[] = []
    const server = serve(
      fakeSession({ state: () => pending(), rejectPlan: (text) => feedback.push(text) }),
    )
    try {
      const response = await send(server.url, 'plan-review', {
        decision: 'reject',
        feedback: '   ',
      })
      expect(response.status).toBe(400)
      expect(feedback).toEqual([])
    } finally {
      server.stop()
    }
  })

  test('rejecting with notes needs no feedback', async () => {
    const feedback: string[] = []
    const server = serve(
      fakeSession({
        state: () => pending([planNote()]),
        rejectPlan: (text) => feedback.push(text),
      }),
    )
    try {
      // The notes are the reason. Making the reader restate them in prose to send them is the
      // step the whole surface exists to remove.
      const response = await send(server.url, 'plan-review', { decision: 'reject' })
      expect(response.status).toBe(200)
      expect(feedback).toEqual([''])
    } finally {
      server.stop()
    }
  })

  test('a note reaches annotatePlan', async () => {
    const added: unknown[] = []
    const server = serve(
      fakeSession({ state: () => pending(), annotatePlan: (input) => added.push(input) }),
    )
    try {
      const response = await send(server.url, 'plan-review/annotate', {
        round: 2,
        rangeStart: 2,
        line: 2,
        lineText: '2. do that',
        body: '  not that bit  ',
      })
      expect(response.status).toBe(200)
      expect(added).toEqual([
        { rangeStart: 2, line: 2, lineText: '2. do that', body: 'not that bit' },
      ])
    } finally {
      server.stop()
    }
  })

  test('a note written against an earlier plan is refused', async () => {
    const added: unknown[] = []
    const server = serve(
      fakeSession({ state: () => pending(), annotatePlan: (input) => added.push(input) }),
    )
    try {
      // Round 1's line 2 is not round 2's line 2. The agent revising while someone is still
      // annotating the last plan is the ordinary case, not a rare race.
      const response = await send(server.url, 'plan-review/annotate', {
        round: 1,
        rangeStart: 2,
        line: 2,
        lineText: '2. do that',
        body: 'not that bit',
      })
      expect(response.status).toBe(409)
      expect(added).toEqual([])
    } finally {
      server.stop()
    }
  })

  test('an empty note is refused', async () => {
    const added: unknown[] = []
    const server = serve(
      fakeSession({ state: () => pending(), annotatePlan: (input) => added.push(input) }),
    )
    try {
      const response = await send(server.url, 'plan-review/annotate', {
        round: 2,
        line: 2,
        body: '   ',
      })
      expect(response.status).toBe(400)
      expect(added).toEqual([])
    } finally {
      server.stop()
    }
  })

  test('a note can be withdrawn by id', async () => {
    const removed: string[] = []
    const server = serve(
      fakeSession({ state: () => pending([planNote()]), removePlanNote: (id) => removed.push(id) }),
    )
    try {
      const response = await send(server.url, 'plan-review/annotation/remove', { id: 'n1' })
      expect(response.status).toBe(200)
      expect(removed).toEqual(['n1'])
    } finally {
      server.stop()
    }
  })
})

describe('broadcast', () => {
  test('pushes the same abbreviated cwd over the socket', async () => {
    const server = serveApp({
      session: fakeSession({ state: () => SOME_STATE }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: `${homedir()}/projects/turnstile`,
      port: 0,
    })
    try {
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}ws`)
      const messages: { type: string; state: { cwd: string } }[] = []
      await new Promise<void>((resolve) => {
        socket.onmessage = (event) => {
          messages.push(JSON.parse(String(event.data)))
          // The first message is the immediate state push `open` sends; trigger the actual
          // broadcast only once that one has been received, so the second is unambiguously
          // the one under test.
          if (messages.length === 1) server.broadcast(SOME_STATE)
          if (messages.length === 2) resolve()
        }
      })
      socket.close()

      expect(messages[1]?.state.cwd).toBe('~/projects/turnstile')
    } finally {
      server.stop()
    }
  })

  /**
   * A streaming turn pushes a full state per token. These pin the coalescing that keeps that
   * off the wire — and, just as importantly, pin what must *not* be delayed: a human waiting on
   * a permission prompt must not wait on a timer meant for prose.
   */
  describe('coalescing', () => {
    const streamed = (revision: number, text: string): SessionState => ({
      ...SOME_STATE,
      revision,
      transcript: [{ kind: 'assistant', text, at: '2026-01-01T00:00:00.000Z' }],
    })

    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      })

    /**
     * Opens a socket, runs `drive`, and returns the frames that arrived after it.
     *
     * Drops the snapshot `open` sends *and* primes one broadcast first: the very first
     * broadcast of a server's life is never coalesced (there is no previous state to compare
     * against) and a quiet period always re-arms the leading edge, so priming is what makes
     * "how many frames did this burst cost" the thing actually being measured.
     */
    const collect = async (
      server: ReturnType<typeof serveApp>,
      drive: () => void,
    ): Promise<SessionState[]> => {
      const frames: SessionState[] = []
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}ws`)
      await new Promise<void>((resolve) => {
        socket.onopen = () => resolve()
      })
      socket.onmessage = (event) => {
        frames.push(JSON.parse(String(event.data)).state)
      }
      server.broadcast(streamed(2, 'priming'))
      await pause(150)
      frames.length = 0

      drive()
      await pause(250)
      socket.close()
      return frames
    }

    test('collapses a burst of transcript-only pushes', async () => {
      const server = serveApp({
        session: fakeSession({ state: () => SOME_STATE }),
        projectTree: fakeProjectTree,
        asker: fakeAsker,
        reader: fakeReader,
        roots: ONE_ROOT,
        cwd: '/repo',
        port: 0,
      })
      try {
        const frames = await collect(server, () => {
          for (let i = 0; i < 40; i++) server.broadcast(streamed(i + 3, `word ${i}`))
        })
        // Leading edge plus one trailing send — not forty.
        expect(frames.length).toBeLessThanOrEqual(2)
        // The last thing streamed always arrives, or the transcript would end mid-sentence.
        expect(frames.at(-1)?.transcript[0]).toMatchObject({ text: 'word 39' })
        // Whatever is dropped, what survives still only ever moves forward.
        const revisions = frames.map((f) => f.revision)
        expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
      } finally {
        server.stop()
      }
    })

    test('sends a non-transcript change immediately, even mid-burst', async () => {
      const server = serveApp({
        session: fakeSession({ state: () => SOME_STATE }),
        projectTree: fakeProjectTree,
        asker: fakeAsker,
        reader: fakeReader,
        roots: ONE_ROOT,
        cwd: '/repo',
        port: 0,
      })
      try {
        const frames = await collect(server, () => {
          server.broadcast(streamed(3, 'a'))
          server.broadcast(streamed(4, 'b'))
          // A permission prompt arrives while prose is still streaming.
          server.broadcast({
            ...streamed(5, 'b'),
            permissions: [
              {
                id: 'p1',
                title: 'Allow Bash to run this command?',
                subject: 'rm -rf build',
                description: null,
                reason: null,
                options: [],
              },
            ],
          })
        })
        const withPrompt = frames.find((f) => f.permissions.length === 1)
        expect(withPrompt).toBeDefined()
        // It must not have waited behind the prose window.
        expect(frames.indexOf(withPrompt as SessionState)).toBeLessThanOrEqual(1)
        // And it carried the prose alongside it rather than stranding it.
        expect(withPrompt?.transcript[0]).toMatchObject({ text: 'b' })
      } finally {
        server.stop()
      }
    })

    test('stop() leaves no pending send behind', async () => {
      const server = serveApp({
        session: fakeSession({ state: () => SOME_STATE }),
        projectTree: fakeProjectTree,
        asker: fakeAsker,
        reader: fakeReader,
        roots: ONE_ROOT,
        cwd: '/repo',
        port: 0,
      })
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}ws`)
      await new Promise<void>((resolve) => {
        socket.onopen = () => resolve()
      })
      server.broadcast(streamed(2, 'a'))
      server.broadcast(streamed(3, 'b'))
      socket.close()
      // If this left a live timer, the test process would not exit.
      expect(() => server.stop()).not.toThrow()
    })
  })
})

/**
 * The bridge for measurements taken in the browser.
 *
 * Keystroke latency is the number the move to CodeMirror was about, and it can only be measured
 * where the keystroke lands. The editor batches its timings and posts them here to be exported
 * with everything else.
 */
describe('/telemetry', () => {
  const serve = (telemetry: RecordingTelemetry) =>
    serveApp({
      session: fakeSession({ state: () => ({ ...SOME_STATE, sessionId: 'sess-42' }) }),
      projectTree: fakeProjectTree,
      asker: fakeAsker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: '/repo',
      port: 0,
      telemetry,
    })

  const report = (url: string, body: unknown) =>
    fetch(`${url}telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('records what the editor measured', async () => {
    const telemetry = recordingTelemetry()
    const server = serve(telemetry)
    try {
      const response = await report(server.url.toString(), {
        measurements: [
          { name: 'editor.keystroke.latency', value: 1.2, attrs: { language: 'typescript' } },
        ],
      })

      expect(response.ok).toBe(true)
      expect(telemetry.records).toEqual([
        {
          name: 'turnstile.editor.keystroke.latency',
          value: 1.2,
          attrs: { language: 'typescript', 'session.id': 'sess-42' },
        },
      ])
    } finally {
      server.stop()
    }
  })

  /** A measurement is never worth an error on the reader's screen. */
  test('accepts a malformed report without recording anything or failing', async () => {
    const telemetry = recordingTelemetry()
    const server = serve(telemetry)
    try {
      const response = await report(server.url.toString(), { measurements: 'nonsense' })

      expect(response.ok).toBe(true)
      expect(telemetry.records).toEqual([])
    } finally {
      server.stop()
    }
  })

  /**
   * Without this, a keystroke latency could not be lined up with the session it was typed in —
   * and `session.id` is the attribute the agent's own spans carry, so it is the join.
   */
  test('stamps the live session s id on what the browser reported', async () => {
    const telemetry = recordingTelemetry()
    const server = serve(telemetry)
    try {
      await report(server.url.toString(), {
        measurements: [{ name: 'editor.build', value: 9 }],
      })

      expect(telemetry.records[0]?.attrs['session.id']).toBe('sess-42')
    } finally {
      server.stop()
    }
  })

  test('ignores a measurement name it does not know', async () => {
    const telemetry = recordingTelemetry()
    const server = serve(telemetry)
    try {
      await report(server.url.toString(), {
        measurements: [{ name: 'invented.metric', value: 1 }],
      })

      expect(telemetry.records).toEqual([])
    } finally {
      server.stop()
    }
  })
})

describe('/ask', () => {
  const FILES = {
    '/repo': {
      files: ['src/a.ts'],
      content: { 'src/a.ts': 'const a = 1\nexport default a\n' },
      binary: ['docs/handbook.pdf'],
    },
  }

  async function ask(payload: unknown, asker: Asker = fakeAsker) {
    askCalls.length = 0
    const server = serveApp({
      session: fakeSession({ state: () => ({ ...SOME_STATE, status: 'working' }) }),
      projectTree: multiRootProjectTree(FILES),
      asker,
      reader: fakeReader,
      roots: ONE_ROOT,
      cwd: '/repo',
      port: 0,
    })
    try {
      const response = await fetch(`${server.url}ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json()) as { answer?: string; error?: string }
      return { status: response.status, body }
    } finally {
      server.stop()
    }
  }

  const QUESTION = {
    root: '/repo',
    path: 'src/a.ts',
    anchor: { startLine: 2, endLine: 2 },
    question: '  Why a default export?  ',
  }

  /**
   * The case the feature exists for. Asking runs no turn and touches no session state, so a
   * busy agent is not in its way — and this is the assertion that keeps it that way.
   */
  test('answers while the agent is mid-turn', async () => {
    const { status, body } = await ask(QUESTION)
    expect(status).toBe(200)
    expect(body.answer).toBe('Because of the tab rows.')
  })

  test('builds the payload from the file on disk, not from anything the browser sent', async () => {
    await ask(QUESTION)
    expect(askCalls[0]?.payload).toContain('2\texport default a')
    expect(askCalls[0]?.root).toBe('/repo')
  })

  test('trims the question and says which lines it is about', async () => {
    await ask(QUESTION)
    expect(askCalls[0]?.payload).toContain('src/a.ts, line 2')
    expect(askCalls[0]?.payload).toContain('Why a default export?')
  })

  test('a null anchor is a question about the whole file', async () => {
    await ask({ ...QUESTION, anchor: null })
    expect(askCalls[0]?.payload).toContain('The whole of src/a.ts.')
  })

  test('carries the thread so far, so a follow-up has its context', async () => {
    await ask({
      ...QUESTION,
      history: [{ question: 'What is this?', answer: 'A default export.' }],
    })
    expect(askCalls[0]?.payload).toContain('Q: What is this?')
  })

  test('a question about nothing is a 400', async () => {
    expect((await ask({ ...QUESTION, question: '   ' })).status).toBe(400)
  })

  test('a file it cannot name is a 400', async () => {
    expect((await ask({ ...QUESTION, path: '' })).status).toBe(400)
  })

  /** A file opened from the project tree is named by path alone, as `/files/content` allows. */
  test('a missing root falls back to the live repository', async () => {
    const { status } = await ask({ ...QUESTION, root: undefined })
    expect(status).toBe(200)
    expect(askCalls[0]?.root).toBe('/repo')
  })

  /** Widening a broken selection to the whole file would answer a question nobody asked. */
  test('a malformed anchor is a 400, not a whole-file question', async () => {
    expect((await ask({ ...QUESTION, anchor: { startLine: 9, endLine: 2 } })).status).toBe(400)
    expect((await ask({ ...QUESTION, anchor: { startLine: 'two' } })).status).toBe(400)
    expect(askCalls).toHaveLength(0)
  })

  test('a malformed history is a 400', async () => {
    expect((await ask({ ...QUESTION, history: [{ question: 'x' }] })).status).toBe(400)
  })

  test('a file that is not there is a 409 saying so', async () => {
    const { status, body } = await ask({ ...QUESTION, path: 'src/gone.ts' })
    expect(status).toBe(409)
    expect(body.error).toContain('src/gone.ts')
  })

  test('a binary file is a 409, not an answer about gibberish', async () => {
    const { status, body } = await ask({ ...QUESTION, path: 'docs/handbook.pdf' })
    expect(status).toBe(409)
    expect(body.error).toContain('binary')
  })

  /** The missing-API-key case: it must say so, not hang and not 500. */
  test("a model that would not answer is a 409 carrying the model's reason", async () => {
    const refusing: Asker = {
      ask: async () => {
        throw new Error('OPENROUTER_API_KEY is not set.')
      },
    }
    const { status, body } = await ask(QUESTION, refusing)
    expect(status).toBe(409)
    expect(body.error).toBe('OPENROUTER_API_KEY is not set.')
  })
})
