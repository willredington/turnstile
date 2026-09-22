import { homedir } from 'node:os'
import { type AskAnchor, askPayload } from '../../core/ask.ts'
import type {
  Asker,
  ProjectTree,
  RepoReader,
  RootRegistry,
  Session,
  Telemetry,
} from '../../core/ports.ts'
import { noopTelemetry, parseBrowserMeasurements, withAttributes } from '../../core/telemetry.ts'
import type { FileRef, SessionState } from '../../core/types.ts'
import index from './ui/index.html'

/**
 * The app's transport.
 *
 * State is pushed over a WebSocket and also readable over HTTP, and the redundancy is
 * deliberate. A push-only design races: a client that connects a moment after a change
 * never learns about it. Push keeps it live; pull makes it correct.
 *
 * Bun bundles `ui/index.html` and its TSX/CSS imports at build time, so the page is a real
 * React app rather than a template string.
 */

export type ServerOptions = {
  session: Session
  projectTree: ProjectTree
  /**
   * Answers a question about a selection (`POST /ask`).
   *
   * Reached from here rather than through the session on purpose: asking runs no turn, writes
   * nothing and touches no session state, so routing it through `Session` would buy nothing and
   * cost the one property the feature exists for — that it works while the agent is busy.
   */
  asker: Asker
  /** The repository, read-only, for the asker's tools. */
  reader: RepoReader
  /** The live session's repository — the file explorer's root when a request names none. */
  roots: RootRegistry
  /** The directory Turnstile was launched in, for the status line's abbreviated `cwd`. */
  cwd: string
  /** Where measurements the browser reports are exported. Silent by default. */
  telemetry?: Telemetry
  port?: number
  /** Injectable so tests can bind an ephemeral port and still learn which one. */
  onListening?: (url: string) => void
}

type Socket = { send(data: string): void }

/** `cwd`, with the home directory collapsed to `~` — the form a status line displays. */
function displayCwd(path: string, home: string = homedir()): string {
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Whether a `/question` POST body's `answers` field is the shape `answerQuestion` expects: a
 *  record from question text to either one selected label or several (multi-select). */
function isAnswers(value: unknown): value is Record<string, string | string[]> {
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).every(
    (v) => typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string')),
  )
}

/** A `/file/hide` or `/file/show` body's file, or null when it does not name one. */
function fileFrom(parsed: Record<string, unknown> | null): FileRef | null {
  const root = typeof parsed?.root === 'string' ? parsed.root : ''
  const path = typeof parsed?.path === 'string' ? parsed.path : ''
  return root === '' || path === '' ? null : { root, path }
}

/**
 * An `/ask` body's anchor: the lines the question is about, or null for the whole file.
 * `undefined` means the field was present and malformed, which is a 400 rather than a
 * whole-file question — silently widening a broken selection to the entire file would answer
 * a question nobody asked.
 */
function anchorFrom(value: unknown): AskAnchor | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const { startLine, endLine } = value as Record<string, unknown>
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return undefined
  const from = startLine as number
  const to = endLine as number
  if (from < 1 || to < from) return undefined
  return { startLine: from, endLine: to }
}

/** An `/ask` body's thread so far, or `undefined` when it is not the shape it claims to be. */
function historyFrom(value: unknown): { question: string; answer: string }[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const turns: { question: string; answer: string }[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { question, answer } = entry as Record<string, unknown>
    if (typeof question !== 'string' || typeof answer !== 'string') return undefined
    turns.push({ question, answer })
  }
  return turns
}

export function serveApp(options: ServerOptions) {
  const { session, projectTree, asker, reader, roots, cwd } = options
  /**
   * Measurements arriving from the browser are stamped with the live session, the same way the
   * session stamps its own — `session.id` is what joins Turnstile's spans to the agent CLI's, so
   * a keystroke latency that did not carry it could not be placed in the session it was typed
   * in. Read per call, since a resume replaces the session under a long-lived server.
   */
  const telemetry = withAttributes(options.telemetry ?? noopTelemetry, () => ({
    'session.id': session.state().sessionId,
  }))
  const sockets = new Set<Socket>()

  /**
   * The root a file-explorer request names, or the live session's repository when it names
   * none, or — before the session has opened — the directory Turnstile was launched in.
   */
  const rootFrom = (request: Request): string =>
    new URL(request.url).searchParams.get('root') ?? roots.knownRoots()[0]?.root ?? cwd

  /**
   * How long a run of transcript-only pushes is allowed to coalesce. Long enough that a
   * streaming turn costs a couple of frames a second instead of dozens; short enough that
   * prose still visibly streams rather than arriving in slabs.
   */
  const STREAM_COALESCE_MS = 50

  let lastSent: SessionState | null = null
  let pending: SessionState | null = null
  let windowTimer: ReturnType<typeof setTimeout> | null = null

  const send = (state: SessionState): void => {
    lastSent = state
    const message = JSON.stringify({
      type: 'state',
      state: { ...state, cwd: displayCwd(cwd) },
    })
    for (const socket of sockets) {
      try {
        socket.send(message)
      } catch {
        // A closed socket is not an error worth failing a turn over; `close` will remove it.
      }
    }
  }

  /**
   * Is this push nothing but more streamed prose?
   *
   * `Session.update` rebuilds the state object by spreading, so every key it did not set keeps
   * its identity — which makes "what actually changed" a handful of pointer comparisons. The
   * per-token firehose (`update({transcript: appendEvent(...)})`) is the only caller that
   * changes the transcript alone, and it is the only one worth delaying. Everything else — a
   * status change, a permission prompt, a question, a new chunk — is rare and goes out at once,
   * so nothing a human is waiting on ever sits in a timer.
   */
  const streamingOnly = (next: SessionState): boolean => {
    if (lastSent === null) return false
    for (const key of Object.keys(next) as (keyof SessionState)[]) {
      if (key === 'revision' || key === 'transcript') continue
      if (next[key] !== lastSent[key]) return false
    }
    return true
  }

  /**
   * Dropping intermediate states is safe by construction: `revision` still only ever increases,
   * which is all the client's out-of-order guard asks of it, and `/state` keeps returning the
   * truth for the pull that closes the reconnect race.
   */
  const broadcast = (state: SessionState): void => {
    if (!streamingOnly(state)) {
      if (windowTimer !== null) {
        clearTimeout(windowTimer)
        windowTimer = null
      }
      pending = null
      send(state)
      return
    }

    if (windowTimer !== null) {
      pending = state
      return
    }

    // Leading edge: nothing has gone out recently, so this one goes now and opens a window for
    // whatever else arrives during it.
    send(state)
    windowTimer = setTimeout(() => {
      windowTimer = null
      if (pending === null) return
      const last = pending
      pending = null
      send(last)
    }, STREAM_COALESCE_MS)
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  async function body(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = await request.json()
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 0,

    routes: {
      '/': index,

      '/state': () => json({ ...session.state(), cwd: displayCwd(cwd) }),

      // Fetched rather than pushed: large, changes on every edit, and `diffRevision` in
      // state is enough for a client to know when to ask again.
      '/diff': async () => json(await session.diff()),

      '/prompt': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''

          // Deliberately not awaited. A turn runs for minutes and the answer the caller
          // needs — what is happening — arrives over the socket, not as a response body.
          void session.send(text)
          return json({ ok: true })
        },
      },

      /**
       * Send every unsent note to the agent, with whatever was typed alongside them. The only
       * way a note reaches the agent. Not awaited, for the same reason `/prompt` is not.
       */
      '/notes/send': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
          void session.sendNotes(text)
          return json({ ok: true })
        },
      },

      /**
       * Something to say while the agent is busy.
       *
       * A separate route from `/prompt` because it is a different act: `/prompt` starts a
       * turn, this one adds to what the next turn will be told. Collapsing them would mean
       * the page deciding, from state it does not own, which of the two it was asking for.
       */
      '/queue': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
          if (text === '') return json({ error: 'nothing to say' }, 400)

          const where =
            typeof parsed?.where === 'string' && parsed.where.trim() !== ''
              ? parsed.where
              : undefined
          session.queue(text, where)
          return json({ ok: true })
        },
      },

      '/queue/remove': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const id = typeof parsed?.id === 'string' ? parsed.id : ''
          if (id === '') return json({ error: 'no message named' }, 400)
          session.unqueue(id)
          return json({ ok: true })
        },
      },

      /**
       * A note on one or more lines of a changed file.
       *
       * Validated here as well as in the page: an empty note reaching the agent is a line
       * number with nothing to say about it.
       */
      '/annotate': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const root =
            typeof parsed?.root === 'string' ? parsed.root : (roots.knownRoots()[0]?.root ?? '')
          const path = typeof parsed?.path === 'string' ? parsed.path : ''
          const note = typeof parsed?.body === 'string' ? parsed.body.trim() : ''
          const line = typeof parsed?.line === 'number' ? parsed.line : null
          if (root === '' || path === '' || note === '' || line === null) {
            return json({ error: 'path, line and body required' }, 400)
          }

          await session.annotate({
            root,
            path,
            line,
            rangeStart: typeof parsed?.rangeStart === 'number' ? parsed.rangeStart : undefined,
            side: parsed?.side === 'old' ? 'old' : 'new',
            lineText: typeof parsed?.lineText === 'string' ? parsed.lineText : '',
            body: note,
          })
          return json({ ok: true })
        },
      },

      // Past conversations, for a "new session" / "resume…" picker. Fetched on demand — most of
      // a session's state changes have nothing to do with it.
      '/sessions': async () => json(await session.listSessions()),

      /**
       * Make an untracked project trackable — `git init` and a first commit — and open its first
       * session. Awaited: the page shows its own progress until this answers.
       */
      '/repo/init': {
        POST: async () => {
          try {
            await session.initRepository()
            return json({ ok: true })
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 500)
          }
        },
      },

      '/session/new': {
        POST: async () => {
          try {
            await session.newSession()
            return json({ ok: true })
          } catch (error) {
            // The session itself refuses mid-turn — a live guard, not a bug —
            // so the caller gets a reason back rather than a bare 500.
            return json({ error: error instanceof Error ? error.message : String(error) }, 409)
          }
        },
      },

      '/session/resume': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : ''
          if (sessionId === '') return json({ error: 'sessionId required' }, 400)

          try {
            await session.resumeSession(sessionId)
            return json({ ok: true })
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 409)
          }
        },
      },

      // The file explorer: every project file, independent of the review board — see
      // docs/superpowers/specs/2026-09-02-file-explorer-design.md.
      '/files': async (request: Request) => {
        return json(await projectTree.list(rootFrom(request)))
      },

      // A binary file answers `{ binary: true }` rather than 404: it is there and readable,
      // it just has no text to send. Its bytes deliberately never reach the browser — laying
      // a PDF out line by line is what froze the whole app.
      '/files/content': async (request: Request) => {
        const root = rootFrom(request)
        const path = new URL(request.url).searchParams.get('path') ?? ''
        const contents = path === '' ? null : await projectTree.read(root, path)
        if (contents === null) return json({ error: 'not found' }, 404)
        return contents.kind === 'binary' ? json({ binary: true }) : json({ text: contents.text })
      },

      '/annotation/remove': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const id = typeof parsed?.id === 'string' ? parsed.id : ''
          if (id === '') return json({ error: 'id required' }, 400)

          await session.removeAnnotation(id)
          return json({ ok: true })
        },
      },

      // A changed file hidden from the tab strip until it next changes, and brought back.
      /**
       * The reader's own edit, saved. Distinct from anything the agent does: the agent's only
       * write path is its `propose_edit` tool, gated in `app/session.ts`'s `runToolWrite`.
       * Text is taken verbatim, including an empty file — emptying a file is a real edit.
       */
      '/file/save': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const file = fileFrom(parsed)
          if (file === null) return json({ error: 'root and path required' }, 400)
          if (typeof parsed?.text !== 'string') return json({ error: 'text required' }, 400)
          const result = await session.saveFile(file, parsed.text)
          // 409: the request was well-formed, the session just would not take it. The reason
          // goes back so the editor can keep the work and say what happened.
          return result.ok ? json({ ok: true }) : json({ error: result.reason }, 409)
        },
      },

      /**
       * One question about one file, answered now.
       *
       * Awaited, unlike `/prompt`: the answer IS the response, and there is no session state
       * for it to arrive through. Nothing here is stored — not as a note, not in `SessionState`,
       * not in `.turnstile/` — so a follow-up sends the thread back with it.
       *
       * 409 rather than 500 for a refusal, the shape `/file/save` uses: a missing API key or a
       * model that failed is a well-formed request the machinery would not serve, and the reader
       * needs to be told which rather than watching a spinner forever.
       */
      '/ask': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const path = typeof parsed?.path === 'string' ? parsed.path : ''
          if (path === '') return json({ error: 'path required' }, 400)
          // Root is optional, the way `/files/content`'s is: a file opened from the project
          // tree is named by path alone, and these two endpoints read the very same files.
          const root =
            typeof parsed?.root === 'string' && parsed.root !== ''
              ? parsed.root
              : (roots.knownRoots()[0]?.root ?? cwd)
          const file = { root, path }
          const question = typeof parsed?.question === 'string' ? parsed.question.trim() : ''
          if (question === '') return json({ error: 'question required' }, 400)
          const anchor = anchorFrom(parsed?.anchor)
          if (anchor === undefined) return json({ error: 'anchor malformed' }, 400)
          const history = historyFrom(parsed?.history)
          if (history === undefined) return json({ error: 'history malformed' }, 400)

          // Read here rather than trusting the browser's copy: the file on disk is what an
          // answer should be about, and a stale editor buffer would have the asker explain code
          // that is no longer there.
          const contents = await projectTree.read(file.root, file.path)
          if (contents === null) return json({ error: `Cannot read ${file.path}.` }, 409)
          if (contents.kind === 'binary') {
            return json({ error: 'That file is binary.' }, 409)
          }

          try {
            const answer = await telemetry.span(
              'turnstile.ask',
              { 'turnstile.path': file.path, 'turnstile.ask.followup': history.length > 0 },
              () =>
                asker.ask({
                  root: file.root,
                  payload: askPayload({
                    path: file.path,
                    fileText: contents.text,
                    anchor,
                    history,
                    question,
                  }),
                  reader,
                }),
            )
            telemetry.count('turnstile.ask.questions', { outcome: 'answered' })
            return json({ answer })
          } catch (error) {
            telemetry.count('turnstile.ask.questions', { outcome: 'failed' })
            return json({ error: error instanceof Error ? error.message : String(error) }, 409)
          }
        },
      },

      /**
       * Measurements taken in the browser — keystroke latency above all, which can only be
       * timed where the keystroke lands. Batched by the editor, validated in
       * `core/telemetry.ts` (an unbounded metric name from outside the process would be a
       * cardinality problem, not just an invalid one), and always answered `ok`: a dropped
       * measurement must never become an error on the reader's screen.
       */
      '/telemetry': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          for (const measurement of parseBrowserMeasurements(parsed)) {
            telemetry.record(measurement.name, measurement.value, measurement.attrs)
          }
          return json({ ok: true })
        },
      },

      '/file/hide': {
        POST: async (request: Request) => {
          const file = fileFrom(await body(request))
          if (file === null) return json({ error: 'root and path required' }, 400)
          await session.hideFile(file)
          return json({ ok: true })
        },
      },

      '/file/show': {
        POST: async (request: Request) => {
          const file = fileFrom(await body(request))
          if (file === null) return json({ error: 'root and path required' }, 400)
          await session.showFile(file)
          return json({ ok: true })
        },
      },

      '/permission': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const id = typeof parsed?.id === 'string' ? parsed.id : ''
          const optionId = typeof parsed?.optionId === 'string' ? parsed.optionId : ''
          if (id === '' || optionId === '') return json({ error: 'id and optionId required' }, 400)

          session.answerPermission(id, optionId)
          return json({ ok: true })
        },
      },

      '/question': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const id = typeof parsed?.id === 'string' ? parsed.id : ''
          const answers = isAnswers(parsed?.answers) ? parsed.answers : null
          if (id === '' || answers === null) return json({ error: 'id and answers required' }, 400)

          session.answerQuestion(id, answers)
          return json({ ok: true })
        },
      },

      '/cancel': {
        POST: async () => {
          await session.cancel()
          return json({ ok: true })
        },
      },

      '/plan-mode': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const mode =
            parsed?.mode === 'plan' ? 'plan' : parsed?.mode === 'default' ? 'default' : null
          if (mode === null) return json({ error: 'mode must be "plan" or "default"' }, 400)

          try {
            await (mode === 'plan' ? session.enterPlanMode() : session.exitPlanMode())
            return json({ ok: true })
          } catch (error) {
            // The session refuses mid-turn — a live guard, not a bug — so the
            // caller gets a reason back rather than a bare 500, same as `/session/new`.
            return json({ error: error instanceof Error ? error.message : String(error) }, 409)
          }
        },
      },

      /**
       * The decision on a submitted plan. Both rules below are enforced here as well as in the
       * page, because the page can be a round behind — a laggy socket, or a second browser tab
       * looking at the same session — and either mistake silently destroys written work.
       */
      '/plan-review': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const pending = session.state().planReview
          if (pending === null) return json({ error: 'no plan is awaiting a decision' }, 409)

          if (parsed?.decision === 'approve') {
            // A note is a disagreement. Approving over one would drop it with the round and
            // tell the agent the plan was fine.
            if (pending.notes.length > 0) {
              return json(
                { error: 'this plan has notes on it — send it back, or remove them' },
                409,
              )
            }
            session.approvePlan()
            return json({ ok: true })
          }
          if (parsed?.decision === 'reject') {
            const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim() : ''
            // Notes are a reason in their own right, so the message is only required without
            // them. A refusal carrying neither tells the agent it was wrong and nothing else.
            if (feedback === '' && pending.notes.length === 0) {
              return json({ error: 'a note or some feedback is required to send a plan back' }, 400)
            }
            session.rejectPlan(feedback)
            return json({ ok: true })
          }
          return json({ error: 'decision must be "approve" or "reject"' }, 400)
        },
      },

      /**
       * A note on lines of the plan awaiting a decision.
       *
       * Separate from `/annotate` rather than a flag on it: that route stores a note against a
       * file, hashes the file to know when the note goes stale, and resolves a root. None of
       * that applies to a plan, and a shared route would have to opt out of all three.
       *
       * `round` is required and checked. A note typed against one revision of the plan names
       * lines that mean something different in the next, and the agent revising its plan while
       * someone is still annotating the old one is the ordinary case, not a rare race.
       */
      '/plan-review/annotate': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const pending = session.state().planReview
          if (pending === null) return json({ error: 'no plan is awaiting a decision' }, 409)

          const round = typeof parsed?.round === 'number' ? parsed.round : null
          if (round !== pending.round) {
            return json({ error: 'that note was written against an earlier plan' }, 409)
          }

          const note = typeof parsed?.body === 'string' ? parsed.body.trim() : ''
          const line = typeof parsed?.line === 'number' ? parsed.line : null
          if (note === '' || line === null) return json({ error: 'line and body required' }, 400)

          session.annotatePlan({
            line,
            rangeStart: typeof parsed?.rangeStart === 'number' ? parsed.rangeStart : line,
            lineText: typeof parsed?.lineText === 'string' ? parsed.lineText : '',
            body: note,
          })
          return json({ ok: true })
        },
      },

      '/plan-review/annotation/remove': {
        POST: async (request: Request) => {
          const parsed = await body(request)
          const id = typeof parsed?.id === 'string' ? parsed.id : ''
          if (id === '') return json({ error: 'id required' }, 400)

          session.removePlanNote(id)
          return json({ ok: true })
        },
      },
    },

    fetch(request, server) {
      if (new URL(request.url).pathname === '/ws') {
        return server.upgrade(request) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },

    websocket: {
      open(socket) {
        sockets.add(socket)
        // Send current state immediately rather than waiting for the next change, so a
        // client that connects during a quiet moment is not staring at nothing.
        socket.send(
          JSON.stringify({
            type: 'state',
            state: { ...session.state(), cwd: displayCwd(cwd) },
          }),
        )
      },
      close(socket) {
        sockets.delete(socket)
      },
      message() {
        // Commands arrive over HTTP. Keeping the socket one-directional means there is one
        // place where an action can be taken, and it is the one with a status code.
      },
    },
  })

  const url = `http://127.0.0.1:${server.port}/`
  options.onListening?.(url)

  return {
    url,
    broadcast,
    stop: () => {
      // A trailing send still in flight would keep the process (and `bun test`) alive well
      // after the server itself is gone.
      if (windowTimer !== null) {
        clearTimeout(windowTimer)
        windowTimer = null
      }
      pending = null
      server.stop(true)
    },
  }
}
