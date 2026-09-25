import { relative, resolve as resolvePath } from 'node:path'
import {
  changedSince,
  contentHash,
  noteFileKey,
  PLAN_PATH,
  planRefusal,
  promptWith,
  staleNotes,
  unsent,
} from '../core/annotations.ts'
import type { TurnstileConfig } from '../core/config.ts'
import { liveChunks, toBoardKeys } from '../core/livechunks.ts'
import { parsePatch } from '../core/patch.ts'
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHistory,
  AnnotationStore,
  EditTarget,
  FindingStore,
  HiddenFileStore,
  OpenedSession,
  Repository,
  Reviewer,
  RootHandle,
  RootRegistry,
  SaveResult,
  Session,
} from '../core/ports.ts'
import { dequeue, enqueue, humanText, promptAhead } from '../core/queue.ts'
import { skipReasons } from '../core/riskbar.ts'
import { appendEvent, appendNotice, appendPlan, appendUser } from '../core/transcript.ts'
import type {
  AgentEvent,
  Annotation,
  Chunk,
  DiffFile,
  DiffView,
  FileFindings,
  LiveChunk,
  Queued,
  RootInfo,
  SentNote,
  SessionState,
  SessionSummary,
  SnapshotId,
  StoredReview,
} from '../core/types.ts'
import { captureBoardFor, chunksOf, fileHashes } from './board.ts'
import { coalesce } from './coalesce.ts'
import { proposedContent, resolveEdit } from './editResolution.ts'
import { review } from './review.ts'

/**
 * One live working session: the conversation, the pending questions, and the board.
 *
 * The board is a plain diff: everything in the checkout that differs from where the session
 * started, with a risk reading per chunk and whatever notes the human has left. Nothing
 * blocks on the human. A note goes to the agent only when the human sends it (`sendNotes`).
 *
 * Owns no I/O of its own. Everything arrives as a port so the turn logic can be tested
 * without a running agent, a git repo, or a model.
 */

export type SessionDeps = {
  // No cwd: every port is already bound to its working directory by the composition root,
  // which is what keeps a location out of the domain logic. The one location this does handle
  // is where the live session works, and it only ever arrives from `repository`.
  connect: AgentConnectionFactory
  /** Past conversations, for the resume picker — readable before any agent is running. */
  history: AgentHistory
  /** Holds the live session's repository as its one root — see `RootRegistry`. */
  roots: RootRegistry
  /** Records and finds each session's baseline. */
  repository: Repository
  annotations: AnnotationStore
  /** Changed files the reader has hidden from the tab strip. */
  hidden: HiddenFileStore
  editTarget: EditTarget
  reviewer: Reviewer
  /** Each session's file reviews, so a resume shows its last review again. */
  findings: FindingStore
  config: TurnstileConfig
  /** Called whenever state changes, so a transport can push. */
  onChange?: (state: SessionState) => void
  /** Called when an edit lands, so a diff view can refresh. */
  onEdit?: () => void
  /** Mints the id for each new conversation, which also names its baseline. A random UUID
   *  unless a test needs predictable ones. */
  mintSessionId?: () => string
  /**
   * When a new session's baseline and agent are created. `'first-prompt'` (the default, and what
   * the app uses) leaves nothing behind for a session that never sends anything; `'start'` opens
   * them as soon as the session is prepared, for callers that drive the agent without a turn.
   */
  openAt?: 'first-prompt' | 'start'
}

/**
 * What a recovered plan's approval says to an agent waiting to be told how to go on.
 *
 * Module scope, not inside `createSession`: a `const` declared after that function's `return`
 * never initialises, so every approval of a recovered plan threw `ReferenceError` instead of
 * reaching the agent. TypeScript does not catch it; the test that sends one does.
 */
const APPROVED_PROMPT =
  'That plan is approved — go ahead and carry it out. It is the plan you submitted before this ' +
  'session was interrupted; nothing about it has changed.'

export function createSession(deps: SessionDeps): Session {
  const { annotations, hidden, editTarget, reviewer, config } = deps
  let state: SessionState = {
    status: 'starting',
    sessionId: '',
    transcript: [],
    permissions: [],
    questions: [],
    revision: 0,
    diffRevision: 0,
    chunks: [],
    fileFindings: [],
    roots: [],
    tracking: 'unknown',
    baseline: null,
    annotations: [],
    hidden: [],
    queued: [],
    model: null,
    thinkingLevel: null,
    contextUsed: null,
    contextSize: null,
    planMode: 'default',
    planReview: null,
    review: null,
  }

  const mintSessionId = deps.mintSessionId ?? (() => crypto.randomUUID())

  const update = (next: Partial<SessionState>): void => {
    state = { ...state, ...next, revision: state.revision + 1 }
    deps.onChange?.(state)
  }

  /**
   * How a background job's failure reaches the human: as a notice in the conversation, the
   * same place a turn's own failures land.
   *
   * These jobs run off every edit and every tool call, so a failure that sticks — a broken
   * repository, a disk that went away — would repeat on each one. Only a *change* of message
   * is worth saying: the first one tells the reader the board is stale, and the ninety after
   * it would only bury the conversation.
   */
  function backgroundFailure(what: string): (error: unknown) => void {
    let lastSaid: string | null = null
    return (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === lastSaid) return
      lastSaid = message
      update({
        transcript: appendNotice(
          state.transcript,
          `${what} failed: ${message}`,
          new Date().toISOString(),
          'bad',
        ),
      })
    }
  }

  /** Serializes write-tool calls so two rapid ones never race two writes to the same file. */
  let proposeEditQueue: Promise<void> = Promise.resolve()

  /** Each file's last review, by `noteFileKey` — current only while the file still hashes the
   *  same (`StoredReview.fileHash`). Loaded from `deps.findings` when a session opens. */
  const reviews = new Map<string, StoredReview>()
  /** Files a review is running on, by `noteFileKey`. */
  const reviewing = new Set<string>()
  /** Why the last review of a file failed, by `noteFileKey`. Cleared by its next review. */
  const failed = new Map<string, string>()

  /**
   * Notes the human asked to send while a turn was running, by id. They go as the next turn —
   * these ones only, not whatever was written after the click.
   */
  let requestedNotes = new Set<string>()

  /** The current handle for one root, or undefined once it is no longer the live one. */
  const handleFor = (root: string): RootHandle | undefined =>
    deps.roots.knownRoots().find((handle) => handle.root === root)

  /** The board as last read, per root: its chunks, the risk bar's skips, and each changed
   *  file's current hash. */
  type RootBoard = {
    chunks: Chunk[]
    skips: ReadonlyMap<string, string>
    hashes: ReadonlyMap<string, string>
  }
  const boards = new Map<string, RootBoard>()

  /**
   * The chunk list and file-level findings, derived whole from the board and the reviews — so a
   * file's findings show exactly while its review is current, and nothing else decides it.
   */
  const render = (): void => {
    const chunks: LiveChunk[] = []
    const fileFindings: FileFindings[] = []
    for (const [root, board] of boards) {
      const key = (path: string) => noteFileKey(root, path)
      const live = liveChunks(board.chunks, board.skips, {
        analyzing: (path) => reviewing.has(key(path)),
        failure: (path) => failed.get(key(path)),
        findingsFor: (path) => {
          const review = reviews.get(key(path))
          return review !== undefined && review.fileHash === board.hashes.get(path)
            ? review.findings
            : null
        },
      })
      chunks.push(...toBoardKeys(live.chunks))
      fileFindings.push(...live.fileFindings.map((entry) => ({ root, ...entry })))
    }
    update({
      chunks,
      fileFindings,
      roots: deps.roots.knownRoots().map((handle): RootInfo => ({ root: handle.root })),
    })
  }

  /** Forget every review, for a session being left. */
  const clearReviews = (): void => {
    reviews.clear()
    reviewing.clear()
    failed.clear()
    if (state.review !== null) update({ review: null })
  }

  /** The live session's stored reviews, as it opens. Unreadable reads as none reviewed. */
  const loadReviews = async (): Promise<void> => {
    clearReviews()
    const stored = await deps.findings.bySession(state.sessionId).catch((): StoredReview[] => [])
    for (const review of stored) reviews.set(noteFileKey(review.root, review.path), review)
  }

  /** One reporter shared by both paths into `refreshChunks` — the coalesced one and the
   *  direct awaits — so a failure that keeps happening is still only said once. */
  const boardFailed = backgroundFailure('Refreshing the board')

  /** Recompute the chunk list from the working tree. */
  const refreshChunks = async (): Promise<void> => {
    try {
      const fresh = new Map<string, RootBoard>()
      let baseline: SessionState['baseline'] = null
      for (const handle of deps.roots.knownRoots()) {
        const board = await captureBoardFor(handle)
        baseline ??= board.resolution.source
        fresh.set(handle.root, {
          chunks: await chunksOf(handle.root, handle.snapshots, board.base, board.next, [
            ...board.deltas,
          ]),
          skips: skipReasons(board.deltas, config.riskBar),
          hashes: await fileHashes(handle.snapshots, board.next, board.deltas),
        })
      }
      boards.clear()
      for (const [root, board] of fresh) boards.set(root, board)
      if (boards.size === 0) {
        update({ chunks: [], fileFindings: [], roots: [], baseline: null })
        return
      }
      render()
      if (baseline !== state.baseline) update({ baseline })
    } catch (error) {
      // The list going stale is a display problem; failing the turn over it is not — this is
      // awaited directly at the end of a turn and on every session switch. But it is not a
      // problem worth hiding either: the board silently freezing on its last good state reads
      // as "nothing changed", which is a lie. So it is caught here and said out loud instead.
      boardFailed(error)
    }
  }

  /**
   * The board, following the agent edit by edit — ahead of the review, which is a model
   * call and costs real time where reading the tree costs milliseconds.
   */
  const refreshBoard = coalesce(refreshChunks, boardFailed)

  const persistFailed = backgroundFailure('Saving the review')

  /**
   * Review every changed file with no current review (`app/review.ts`). Coalesced: asked for
   * again while one runs, it runs once more after, over whatever is still unreviewed by then.
   */
  const startReview = coalesce(async () => {
    const sessionId = state.sessionId
    if (sessionId === '') return
    // A review outlives nothing: once the session it was for is left, what it says is dropped.
    const live = () => state.sessionId === sessionId
    await review({
      roots: deps.roots,
      reviewer,
      riskBar: config.riskBar,
      reviewedHash: (root, path) => reviews.get(noteFileKey(root, path))?.fileHash,
      onReviewing: (root, paths) => {
        if (!live()) return
        for (const path of paths) {
          reviewing.add(noteFileKey(root, path))
          failed.delete(noteFileKey(root, path))
        }
        update({
          review: {
            step: 'preparing',
            files: paths,
            startedAt: new Date().toISOString(),
            timeoutMs: config.review.timeoutMs,
            toolCalls: 0,
            current: null,
          },
        })
        render()
      },
      onProgress: (_root, progress) => {
        if (!live() || state.review === null) return
        update({ review: { ...state.review, ...progress } })
      },
      onReviewed: (root, stored) => {
        if (!live()) return
        for (const entry of stored) {
          reviews.set(noteFileKey(root, entry.path), entry)
          reviewing.delete(noteFileKey(root, entry.path))
        }
        update({ review: null })
        render()
        deps.findings.put(sessionId, stored).catch(persistFailed)
      },
      onFailed: (root, paths, message) => {
        if (!live()) return
        for (const path of paths) {
          reviewing.delete(noteFileKey(root, path))
          failed.set(noteFileKey(root, path), message)
        }
        update({ review: null })
        render()
      },
    }).finally(() => {
      // Whatever ended the run, the bar does not outlive it.
      if (live() && state.review !== null) update({ review: null })
    })
  }, backgroundFailure('The review'))

  /** The live root's tree right now, or null when there is none or it cannot be read — the
   *  before and after of a turn, to tell whether it changed anything. */
  const treeNow = async (): Promise<SnapshotId | null> => {
    const handle = deps.roots.knownRoots()[0]
    if (handle === undefined) return null
    return handle.snapshots.capture().catch(() => null)
  }

  /** Review what a turn changed, if it changed anything. */
  const reviewIfChanged = async (before: SnapshotId | null): Promise<void> => {
    const after = await treeNow()
    if (after !== null && after !== before) startReview()
  }

  /** `refreshAnnotations` and `refreshHidden`, for the edit path, where changes arrive in
   *  bursts. */
  const clearStaleNotes = coalesce(async () => {
    if (state.sessionId === '') return
    await refreshAnnotations()
    await refreshHidden()
  }, backgroundFailure('Refreshing notes'))

  /** The tree may have changed — re-derive the board, and let the diff pane know to refetch.
   *  Not the review: that waits for the turn to end (`turn`), or for the human (`reviewNow`). */
  function afterPossibleEdit(): void {
    refreshBoard()
    clearStaleNotes()
    deps.onEdit?.()
    update({ diffRevision: state.diffRevision + 1 })
  }

  const onEvent = (event: AgentEvent): void => {
    if (event.kind === 'permission') {
      update({
        permissions: [
          ...state.permissions,
          {
            id: event.id,
            title: event.title,
            subject: event.subject,
            description: event.description,
            reason: event.reason,
            ...(event.flagged === undefined ? {} : { flagged: event.flagged }),
            options: event.options,
          },
        ],
      })
      return
    }

    if (event.kind === 'permission-resolved') {
      update({ permissions: state.permissions.filter((p) => p.id !== event.id) })
      return
    }

    if (event.kind === 'question') {
      update({
        questions: [...state.questions, { id: event.id, questions: event.questions }],
      })
      return
    }

    if (event.kind === 'question-resolved') {
      update({ questions: state.questions.filter((q) => q.id !== event.id) })
      return
    }

    if (event.kind === 'config-update') {
      update({ model: event.model, thinkingLevel: event.thinkingLevel })
      return
    }

    if (event.kind === 'usage-update') {
      update({ contextUsed: event.contextUsed, contextSize: event.contextSize })
      return
    }

    // A plan from a resumed session's history. It is already decided — nothing is waiting on
    // it — so it goes straight into the record rather than onto the plan tab.
    if (event.kind === 'plan') {
      planRound = Math.max(planRound, event.round)
      if (event.outcome === 'standing') {
        // Still the plan on the table: never answered, or sent back and never replaced. It
        // comes back as the decision it still is, rather than as a record of a settled one.
        update({
          planReview: { plan: event.text, round: event.round, notes: [], recovered: true },
        })
        return
      }
      update({
        transcript: appendPlan(
          state.transcript,
          event.text,
          event.round,
          event.outcome,
          new Date().toISOString(),
        ),
      })
      return
    }

    // Authoritative, not just a mirror of what `enterPlanMode`/`exitPlanMode` already set
    // optimistically: this is also how a model-suggested mode change is picked up.
    if (event.kind === 'plan-mode-update') {
      update({ planMode: event.mode })
      return
    }

    // The process behind the plan is gone, so nothing will ever read the decision. Clear it
    // before the error reaches the transcript, so the reader sees the failure rather than a
    // plan tab still asking to be answered.
    if (event.kind === 'agent-error') {
      abandonPlanReview('The agent stopped before this plan was answered.')
    }

    update({ transcript: appendEvent(state.transcript, event, new Date().toISOString()) })

    // An agent can change files without going through the write tool — Bash (`sed`, a
    // heredoc), `NotebookEdit`, an MCP tool, a subagent — so any finished tool call that is not
    // a plain read, failed ones too (they can touch files before erroring), is the signal to
    // re-read the tree. Cheap: the board is a git snapshot, coalesced.
    if (
      event.kind === 'tool' &&
      event.toolKind !== 'read' &&
      event.toolKind !== 'search' &&
      event.toolKind !== 'fetch' &&
      (event.status === 'completed' || event.status === 'failed')
    ) {
      afterPossibleEdit()
    }
  }

  /**
   * The one path a file's contents change through — see `Session.writeFile`. Handed to the agent
   * connection as its `writeFile` callback.
   *
   * Confined to the repository the live session works in. `input.path` arrives already made
   * relative to the agent's cwd by `buildWriteTool` (`adapters/agent-sdk/client.ts`) — an
   * absolute path outside it becomes a relative string with `..` segments — so it is resolved
   * back to absolute here, and anything that lands outside the repository is refused rather
   * than written somewhere nothing tracks.
   */
  async function runToolWrite(input: {
    path: string
    oldText: string | null
    newText: string
  }): Promise<
    { decision: 'allow'; fileContent: string } | { decision: 'reject'; reasoning: string }
  > {
    const absolutePath = resolvePath(opened?.cwd ?? '', input.path)
    const handle = opened === null ? null : deps.roots.rootFor(absolutePath)
    if (handle === null) {
      return {
        decision: 'reject',
        reasoning:
          `${input.path} is outside this repository (${opened?.root ?? 'none open'}). ` +
          'Every change in this session has to be made inside it.',
      }
    }
    const path = relative(handle.root, absolutePath)

    // Validated, because `old_text` mismatches silently no-op under `String.replace` (see
    // `resolveEdit`), and a no-op write is a worse failure mode than a rejection the agent can
    // act on.
    const current = await editTarget.read(handle.root, path)
    const resolved = resolveEdit(path, current, input.oldText)
    if (!resolved.ok) {
      return { decision: 'reject', reasoning: resolved.message }
    }

    const proposed = proposedContent(current, input.oldText, input.newText)
    await editTarget.write(handle.root, path, proposed)
    afterPossibleEdit()
    return { decision: 'allow', fileContent: proposed }
  }

  /**
   * How many plans this session has submitted.
   *
   * Counted here rather than derived from `state.planReview?.round`, which is null between
   * rounds — `requestPlanApproval` clears it before returning the refusal, so the agent's revised
   * plan always arrived to find nothing to count from and every round called itself the first.
   * Nothing caught it because nothing downstream used the number for more than a caption; the
   * document surface keys a tab, a scroll position and a note's validity off it.
   */
  let planRound = 0

  /** Resolves the promise a pending plan review is blocked on — `null` whenever none is open. */
  let resolvePlanReview:
    | ((result: { kind: 'approve' } | { kind: 'reject'; feedback: string }) => void)
    | null = null

  /**
   * Take a pending plan off the board when there is no longer anyone listening for the answer —
   * the agent process died, or the session it belonged to was left.
   *
   * Without this the plan stays pinned and the only way out is to decide a plan nobody will
   * receive. Resolving a resolver whose SDK caller is gone is harmless: `requestPlanApproval`
   * runs to its end and its return value is dropped with the dead call. Rejected rather than
   * approved, because approving also flips the permission mode back to `default`, and an agent
   * that never heard the answer should stay in plan mode for whoever picks it up next.
   */
  function abandonPlanReview(reason: string): void {
    if (state.planReview === null) return
    resolvePlanReview?.({ kind: 'reject', feedback: reason })
    resolvePlanReview = null
    update({ planReview: null })
  }

  /**
   * Handed to the agent connection as its `requestPlanApproval` callback, for the SDK's built-in
   * `ExitPlanMode` tool. The whole decision lives in `state.planReview`, settled here directly.
   *
   * No timeout, deliberately, same as every other blocking prompt in this session (permission,
   * question) — the agent is genuinely stuck mid-tool-call; there is nothing to degrade to.
   */
  async function requestPlanApproval(
    plan: string,
  ): Promise<{ decision: 'allow' } | { decision: 'reject'; reasoning: string }> {
    // A fresh round starts with no notes: this is a different plan, and carrying the last
    // round's objections forward would refuse it for things it may already have fixed.
    planRound += 1
    update({ planReview: { plan, round: planRound, notes: [], recovered: false } })

    const result = await new Promise<{ kind: 'approve' } | { kind: 'reject'; feedback: string }>(
      (resolve) => {
        resolvePlanReview = resolve
      },
    )
    resolvePlanReview = null
    // The plan tab is transient, so without this the plan went with it — approving one erased
    // the thing that had just been agreed to. Recorded at the decision, not at the submission:
    // until then it is still on the tab, where it can still be argued with.
    update({
      planReview: null,
      transcript: appendPlan(
        state.transcript,
        plan,
        planRound,
        result.kind === 'reject' ? 'sent-back' : 'approved',
        new Date().toISOString(),
      ),
    })

    if (result.kind === 'reject') {
      return { decision: 'reject', reasoning: result.feedback }
    }

    // Confirmed live safe to call from inside the `canUseTool` handler this ultimately resolves
    // for (the SDK round-trips a `system/status` update back through `onEvent` right after,
    // which is what actually settles `state.planMode` — this call is what triggers it).
    await connection?.setPermissionMode('default').catch(() => {})
    return { decision: 'allow' }
  }

  /** Null until the live session's first prompt (or a resume) opens it — and always, for a
   *  project that is not a git repository. */
  let connection: AgentConnection | null = null
  /** Where the live session works, once opened. */
  let opened: OpenedSession | null = null

  /**
   * Open `sessionId` — recording its baseline the first time — and a fresh agent connection.
   * The old connection, if any, is stopped first. The repository becomes the registry's one
   * root, bound to this session's baseline, before anything captures.
   */
  const openSession = async (sessionId: string): Promise<AgentConnection> => {
    const where = await deps.repository.open(sessionId)
    deps.roots.activate(where.root, sessionId)
    connection?.stop()
    const fresh = deps.connect(onEvent, runToolWrite, requestPlanApproval, where.cwd)
    connection = fresh
    opened = where
    update({ roots: [{ root: where.root }] })
    return fresh
  }

  /**
   * Point the session at a conversation that does not exist yet: a fresh session id and no
   * baseline, agent or root until the first prompt (`ensureOpened`), so an app start or "new
   * session" that never sends anything leaves nothing behind.
   */
  const prepareSession = (sessionId: string): void => {
    connection?.stop()
    connection = null
    opened = null
    deps.roots.deactivate()
    abandonPlanReview('This session was left before the plan was answered.')
    planRound = 0
    boards.clear()
    clearReviews()
    update({
      sessionId,
      roots: [],
      chunks: [],
      fileFindings: [],
      baseline: null,
      planMode: 'default',
    })
  }

  /**
   * The live session's agent, recording its baseline and starting the conversation first if
   * this is its first prompt — so the baseline is the checkout as it stood before the agent could
   * act.
   *
   * Only at the first prompt, not at the agent's first edit or Bash call: by its first edit it
   * has already been running, and could have changed things through a tool Turnstile does not
   * watch.
   */
  const ensureOpened = async (): Promise<AgentConnection> => {
    if (connection !== null) return connection
    const sessionId = state.sessionId
    const fresh = await openSession(sessionId)
    await fresh.start(sessionId)
    // Plan mode can be switched on before anything is running; carry it over.
    if (state.planMode === 'plan') await fresh.setPermissionMode('plan')
    return fresh
  }

  /**
   * Shared by `newSession` and `resumeSession`: leave the live session and open another
   * conversation. Refused mid-turn: switching away would abandon the in-flight prompt.
   */
  const switchTo = async (open: () => Promise<void>, notice: string): Promise<void> => {
    if (state.status !== 'idle') {
      throw new Error('cannot switch sessions while a turn is in progress')
    }

    requestedNotes = new Set()
    // The plan belonged to the session being left. `newSession` cleared it through
    // `prepareSession`; a resume did not, so an unanswerable plan followed the reader into the
    // session they had just opened and pinned itself to its tab strip.
    abandonPlanReview('This session was left before the plan was answered.')
    planRound = 0
    update({
      transcript: [],
      permissions: [],
      questions: [],
      queued: [],
      chunks: [],
      fileFindings: [],
      annotations: [],
      hidden: [],
    })

    await open()

    // A different baseline: the diff pane's copy belongs to the session just left.
    update({
      status: 'idle',
      transcript: appendNotice(state.transcript, notice, new Date().toISOString()),
      diffRevision: state.diffRevision + 1,
    })
    // Its last review comes back with it, for every file that has not changed since. The rest
    // read "not reviewed" until a turn changes something or the human asks (`reviewNow`).
    await loadReviews()
    await refreshChunks()
    await refreshAnnotations()
    await refreshHidden()
  }

  /** Prepare the first session, or record why none can be opened. */
  const start = async (): Promise<void> => {
    const tracking = await deps.repository.status()
    update({ tracking })
    if (tracking !== 'git') return

    prepareSession(mintSessionId())
    if (deps.openAt === 'start') await ensureOpened()
    update({ status: 'idle' })
    await refreshChunks()
    await refreshAnnotations()
    await refreshHidden()
  }

  return {
    state: () => state,

    /**
     * What has changed since the session's baseline.
     *
     * Computed on demand rather than held in state: it is large, it changes on every edit,
     * and a stale copy pushed alongside unrelated state changes would be worse than none.
     */
    async diff(): Promise<DiffView> {
      const primary = deps.roots.knownRoots()[0]
      if (primary === undefined) {
        return { base: '', files: [], error: null, branch: null }
      }

      try {
        const board = await captureBoardFor(primary)
        return {
          base: board.base,
          files: await diffFiles(primary, board.base, board.next, board.deltas),
          error: null,
          branch: board.resolution.branch,
        }
      } catch (error) {
        // The pane says why rather than rendering an empty diff, which would read as "nothing
        // changed" — the one thing it must never say incorrectly.
        return {
          base: '',
          files: [],
          error: error instanceof Error ? error.message : String(error),
          branch: null,
        }
      }
    },

    start,

    async initRepository(): Promise<void> {
      if (state.tracking === 'git') return
      await deps.repository.init()
      await start()
    },

    async newSession(): Promise<void> {
      await switchTo(async () => {
        prepareSession(mintSessionId())
        if (deps.openAt === 'start') await ensureOpened()
      }, 'Started a new session')
    },

    /** Opens straight away, unlike a new session: replaying its history needs an agent. */
    async resumeSession(sessionId: string): Promise<void> {
      await switchTo(async () => {
        const fresh = await openSession(sessionId)
        const id = await fresh.loadSession(sessionId)
        update({ sessionId: id, planMode: 'default' })
      }, 'Resumed a previous session')
    },

    /**
     * Every session Turnstile started here, newest first: the conversations recorded under the
     * project directory that also have a baseline. Anything else run there (a plain `claude`
     * session) has no starting point to measure a board from, so it is not listed.
     */
    async listSessions(): Promise<SessionSummary[]> {
      if (state.tracking !== 'git') return []
      const [ids, summaries] = await Promise.all([
        deps.repository.sessionIds().catch((): string[] => []),
        deps.history.listSessions().catch((): SessionSummary[] => []),
      ])
      const known = new Set(ids)
      return summaries
        .filter((summary) => known.has(summary.sessionId))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    },

    async send(text: string): Promise<void> {
      if (state.status === 'working') return
      await deliverText(text, text, [])
    },

    async sendNotes(text = ''): Promise<void> {
      const notes = unsent(state.annotations)
      if (notes.length === 0 && text.trim() === '') return
      if (state.status === 'working') {
        for (const note of notes) requestedNotes.add(note.id)
        if (text.trim() !== '') {
          update({ queued: enqueue(state.queued, text, noteId(), new Date().toISOString()) })
        }
        return
      }
      await deliverText(text, text.trim() === '' ? null : text, notes)
    },

    answerPermission(id: string, optionId: string): void {
      connection?.answerPermission(id, optionId)
    },

    answerQuestion(id: string, answers: Record<string, string | string[]>): void {
      connection?.answerQuestion(id, answers)
    },

    writeFile(input: { path: string; oldText: string | null; newText: string }) {
      const result = proposeEditQueue.then(() => runToolWrite(input))
      proposeEditQueue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },

    queue(text: string, where?: string): void {
      const idle = state.status === 'idle'
      update({ queued: enqueue(state.queued, text, noteId(), new Date().toISOString(), where) })
      if (idle) void deliverText('', null, [])
    },

    unqueue(id: string): void {
      update({ queued: dequeue(state.queued, id) })
    },

    async annotate(input): Promise<void> {
      if (input.body.trim() === '' || handleFor(input.root) === undefined) return
      const content = await editTarget.read(input.root, input.path).catch(() => null)
      await annotations.add({
        id: noteId(),
        sessionId: state.sessionId,
        root: input.root,
        path: input.path,
        line: input.line,
        rangeStart: input.rangeStart ?? input.line,
        side: input.side,
        lineText: input.lineText,
        body: input.body.trim(),
        at: new Date().toISOString(),
        sentAt: null,
        fileHash: contentHash(content),
      })
      await refreshAnnotations()
    },

    async removeAnnotation(id: string): Promise<void> {
      await annotations.remove(state.sessionId, id)
      requestedNotes.delete(id)
      await refreshAnnotations()
    },

    async saveFile(file, text): Promise<SaveResult> {
      if (handleFor(file.root) === undefined) {
        return {
          ok: false,
          reason:
            `${file.root} is not a root this session is working in, so nothing was written. ` +
            'This usually means no session has opened yet.',
        }
      }
      try {
        await editTarget.write(file.root, file.path, text)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      afterPossibleEdit()
      return { ok: true }
    },

    async hideFile(file): Promise<void> {
      if (handleFor(file.root) === undefined) return
      const content = await editTarget.read(file.root, file.path).catch(() => null)
      await hidden.hide({
        sessionId: state.sessionId,
        root: file.root,
        path: file.path,
        fileHash: contentHash(content),
        at: new Date().toISOString(),
      })
      await refreshHidden()
    },

    async showFile(file): Promise<void> {
      await hidden.show(state.sessionId, file.root, file.path)
      await refreshHidden()
    },

    reviewNow(): void {
      if (state.sessionId === '') return
      void (async () => {
        await refreshChunks()
        startReview()
      })()
    },

    async enterPlanMode(): Promise<void> {
      if (state.status !== 'idle') {
        throw new Error('cannot change plan mode while a turn is in progress')
      }
      await connection?.setPermissionMode('plan')
      update({ planMode: 'plan' })
    },

    async exitPlanMode(): Promise<void> {
      if (state.status !== 'idle') {
        throw new Error('cannot change plan mode while a turn is in progress')
      }
      await connection?.setPermissionMode('default')
      update({ planMode: 'default' })
    },

    /**
     * A recovered plan has no `canUseTool` call to answer, so the decision is delivered as the
     * next thing said to the agent instead. It is waiting for exactly that: the last thing it
     * was told was to stop and wait to be told how to proceed.
     */
    approvePlan(): void {
      const pending = state.planReview
      if (pending === null) return
      if (!pending.recovered) {
        resolvePlanReview?.({ kind: 'approve' })
        return
      }
      update({
        planReview: null,
        planMode: 'default',
        transcript: appendPlan(
          state.transcript,
          pending.plan,
          pending.round,
          'approved',
          new Date().toISOString(),
        ),
      })
      void (async () => {
        await connection?.setPermissionMode('default').catch(() => {})
        // `null`, not the prompt: approving is a click, not a sentence, and `turn` writes no
        // transcript entry at all when nothing was typed and no notes went. The plan's own
        // record — "plan — approved" — is the trace of what happened.
        await deliverText(APPROVED_PROMPT, null, [])
      })()
    },

    /**
     * The notes and the typed message go back as one refusal, composed here rather than by the
     * caller: the notes live on `state.planReview` and nothing outside this file can read them
     * at the moment the decision is made.
     */
    rejectPlan(feedback: string): void {
      const pending = state.planReview
      if (pending === null) return
      const reasoning = planRefusal(pending.notes, feedback)
      // Nothing to act on. Refusing with an empty reason burns a round and tells the agent only
      // that it was wrong, which is the one thing it cannot use.
      if (reasoning === '') return
      if (!pending.recovered) {
        resolvePlanReview?.({ kind: 'reject', feedback: reasoning })
        return
      }
      update({
        planReview: null,
        transcript: appendPlan(
          state.transcript,
          pending.plan,
          pending.round,
          'sent-back',
          new Date().toISOString(),
        ),
      })
      // The agent is handed the composed refusal; the reader sees what they actually wrote, with
      // their notes beside it — the same shape "send notes" has always had.
      void deliverText(
        reasoning,
        feedback.trim() === '' ? null : feedback.trim(),
        [],
        pending.notes.map(({ path, line, rangeStart, side, lineText, body }) => ({
          path,
          line,
          rangeStart,
          side,
          lineText,
          body,
        })),
      )
    },

    annotatePlan(input): void {
      const pending = state.planReview
      if (pending === null || input.body.trim() === '') return
      const note: Annotation = {
        id: noteId(),
        sessionId: state.sessionId,
        // A plan is not a file. Neither of these is ever resolved against the filesystem — see
        // `PLAN_PATH` — and no `fileHash` is recorded, since there is nothing to hash.
        root: '',
        path: PLAN_PATH,
        line: input.line,
        rangeStart: input.rangeStart,
        side: 'new',
        lineText: input.lineText,
        body: input.body.trim(),
        at: new Date().toISOString(),
        sentAt: null,
      }
      update({ planReview: { ...pending, notes: [...pending.notes, note] } })
    },

    removePlanNote(id: string): void {
      const pending = state.planReview
      if (pending === null) return
      const notes = pending.notes.filter((note) => note.id !== id)
      if (notes.length === pending.notes.length) return
      update({ planReview: { ...pending, notes } })
    },

    async cancel(): Promise<void> {
      // Interrupting does not settle a `canUseTool` call already in flight, so a plan submitted
      // just before the interrupt would otherwise stay pinned with nothing listening. The agent
      // is still alive here, so it does receive this as the plan's outcome.
      abandonPlanReview('The human cancelled the turn before answering this plan.')
      await connection?.cancel()
    },

    stop(): void {
      connection?.stop()
    },
  }

  /** Unique enough for a list nobody sorts by id. */
  function noteId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Re-read the session's notes, dropping any whose file has changed since they were written
   * (`staleNotes`) — so this is also how a note gets cleared: after an edit, and on opening a
   * session whose files changed while the app was closed. Best-effort: a note that fails to be
   * removed stays on screen, where the reader can see it and remove it themselves.
   */
  async function refreshAnnotations(): Promise<void> {
    const notes = await annotations.bySession(state.sessionId).catch(() => [])
    const stale = new Set<string>()
    for (const note of staleNotes(notes, await currentTexts(notes))) {
      try {
        await annotations.remove(state.sessionId, note.id)
        requestedNotes.delete(note.id)
        stale.add(note.id)
      } catch {
        // Left in place; the next refresh tries again.
      }
    }
    update({ annotations: notes.filter((note) => !stale.has(note.id)) })
  }

  /**
   * Re-read the session's hidden files, showing again any whose file has changed since it was
   * hidden — new work on a file is not something the reader has read. Best-effort, like notes: an
   * entry that fails to be removed is still dropped from what the UI hides, and the next refresh
   * tries the store again.
   */
  async function refreshHidden(): Promise<void> {
    const entries = await hidden.bySession(state.sessionId).catch(() => [])
    const changed = new Set(changedSince(entries, await currentHashes(entries)))
    for (const entry of changed) {
      await hidden.show(state.sessionId, entry.root, entry.path).catch(() => {})
    }
    update({
      hidden: entries
        .filter((entry) => !changed.has(entry))
        .map((entry) => ({ root: entry.root, path: entry.path })),
    })
  }

  /** Each fingerprinted file's current text, read once per file. A file that cannot be read is
   *  left out: unreadable is not the same as changed. `staleNotes` needs the text itself, not a
   *  fingerprint, because it checks a note against the lines it quoted rather than the file. */
  async function currentTexts(
    entries: { root: string; path: string; fileHash?: string }[],
  ): Promise<Map<string, string | null>> {
    const current = new Map<string, string | null>()
    for (const entry of entries) {
      const key = noteFileKey(entry.root, entry.path)
      if (entry.fileHash === undefined || current.has(key)) continue
      try {
        current.set(key, await editTarget.read(entry.root, entry.path))
      } catch {
        // Left out, so whatever was recorded against it stays.
      }
    }
    return current
  }

  /** Each fingerprinted file's current `contentHash`, read once per file — the hidden-file rule
   *  still works on the whole file, since hiding is about the file, not about any line in it. */
  async function currentHashes(
    entries: { root: string; path: string; fileHash?: string }[],
  ): Promise<Map<string, string>> {
    const current = new Map<string, string>()
    for (const entry of entries) {
      const key = noteFileKey(entry.root, entry.path)
      if (entry.fileHash === undefined || current.has(key)) continue
      try {
        current.set(key, contentHash(await editTarget.read(entry.root, entry.path)))
      } catch {
        // Left out, so whatever was recorded against it stays.
      }
    }
    return current
  }

  /**
   * Mark notes delivered, before the agent is told rather than after: a note delivered twice
   * reads as a second complaint about the same line, which is worse than one that was lost —
   * and the note is still on screen either way, so a loss is visible and a repeat is not.
   */
  async function markDelivered(notes: Annotation[]): Promise<void> {
    if (notes.length === 0) return
    await annotations
      .markSent(
        state.sessionId,
        notes.map((note) => note.id),
        new Date().toISOString(),
      )
      .catch(() => {})
    await refreshAnnotations()
  }

  /** Undo `markDelivered` for a turn that failed before the agent finished it. */
  async function markUndelivered(notes: Annotation[]): Promise<void> {
    if (notes.length === 0) return
    await annotations
      .markUnsent(
        state.sessionId,
        notes.map((note) => note.id),
      )
      .catch(() => {})
    await refreshAnnotations()
  }

  /**
   * Take everything typed while the agent was busy, and clear it — as it is handed over rather
   * than after the agent replies, for the same reason notes are.
   */
  function drainQueue(): Queued[] {
    const carried = state.queued
    if (carried.length > 0) update({ queued: [] })
    return carried
  }

  /** The notes asked for mid-turn, still unsent — taken, since they are being delivered. */
  function takeRequestedNotes(): Annotation[] {
    const requested = unsent(state.annotations).filter((note) => requestedNotes.has(note.id))
    requestedNotes = new Set()
    return requested
  }

  /** One root's files between two of its own trees, in the shape `diff()` renders. */
  async function diffFiles(
    handle: RootHandle,
    base: SnapshotId,
    next: SnapshotId,
    deltas: Awaited<ReturnType<typeof captureBoardFor>>['deltas'],
  ): Promise<DiffFile[]> {
    const files: DiffFile[] = []
    for (const delta of deltas) {
      const patch = await handle.snapshots.patch(base, next, delta.path, delta.previousPath)
      files.push({
        root: handle.root,
        path: delta.path,
        ...(delta.previousPath === undefined ? {} : { previousPath: delta.previousPath }),
        status: delta.status,
        patch: parsePatch(patch, delta.path),
      })
    }
    return files
  }

  /**
   * Run one turn, then keep going while there is anything left to say: whatever was queued
   * while the agent was busy, and any notes the human asked to send mid-turn.
   *
   * Callers are expected to have already decided a turn is safe to start — this only refuses
   * if one somehow slipped through anyway, so a caller that forgets the check fails safe rather
   * than starting a second turn on top of one already running.
   */
  async function deliverText(
    text: string,
    said: string | null,
    notes: Annotation[],
    shown?: SentNote[],
  ): Promise<void> {
    if (state.status === 'working') return

    let next = text
    let spoken = said
    let carrying = notes
    // Only the first turn is the one `shown` describes; anything queued behind it is its own
    // message with its own notes.
    let showing = shown
    for (;;) {
      await turn(next, spoken, carrying, showing)
      showing = undefined
      const queued = drainQueue()
      const requested = takeRequestedNotes()
      if (queued.length === 0 && requested.length === 0) return
      // Two different strings on purpose: the agent needs the preamble explaining when these
      // were written; the transcript needs what the person actually typed.
      next = promptAhead(queued, '')
      const typed = humanText(queued)
      spoken = typed === '' ? null : typed
      carrying = requested
    }
  }

  /** One turn: say it, wait for the agent to finish, then bring the board up to date. */
  /**
   * `shown` overrides what the transcript shows for `notes`, for the one case where the two
   * differ: a plan sent back. There, the agent is handed a composed refusal that already
   * quotes every note (`planRefusal`), so passing those notes as `notes` too would send them
   * twice — and they are not in the annotation store, so there is nothing to mark delivered.
   * The reader still has to see them, and see them as notes rather than as a wall of prose they
   * did not write.
   */
  async function turn(
    text: string,
    display: string | null,
    notes: Annotation[],
    shown?: SentNote[],
  ): Promise<void> {
    if (state.tracking !== 'git') return
    if (text.trim() === '' && notes.length === 0) return

    // What the transcript shows: what the person typed, and the notes that went with it, as
    // they wrote them.
    const typed = display === null ? '' : display.trim()
    const shownNotes =
      shown ??
      notes.map(({ path, line, rangeStart, side, lineText, body }) => ({
        path,
        line,
        rangeStart,
        side,
        lineText,
        body,
      }))
    update({
      status: 'working',
      ...(typed === '' && shownNotes.length === 0
        ? {}
        : {
            transcript: appendUser(state.transcript, typed, new Date().toISOString(), shownNotes),
          }),
    })

    let current: AgentConnection
    try {
      current = await ensureOpened()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      update({
        status: 'idle',
        transcript: appendNotice(
          state.transcript,
          `Could not open this session: ${message}`,
          new Date().toISOString(),
          'bad',
        ),
      })
      return
    }

    await markDelivered(notes)

    // The tree before the agent acts, so the end of the turn can tell whether it changed
    // anything — and only then pay for a review.
    const before = await treeNow()

    let stopReason: string
    try {
      stopReason = await current.prompt(promptWith(notes, text))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A plan submitted during this turn is blocked on a process that has just failed, and
      // `processDied` only reports `agent-error` when no turn was waiting — this is the other
      // half of that. Without it the turn goes idle behind a plan tab nobody can answer.
      abandonPlanReview('The agent stopped before this plan was answered.')
      // Marked delivered before the prompt went out (`markDelivered`), but the turn never
      // finished — the process died or the prompt was refused — so nobody acted on them. Put
      // them back rather than leave them reading "sent" with no way to send them again.
      await markUndelivered(notes)
      update({
        status: 'idle',
        transcript: appendNotice(state.transcript, message, new Date().toISOString(), 'bad'),
      })
      await refreshChunks()
      // What it changed before it failed is still work on the board.
      await reviewIfChanged(before)
      return
    }

    if (stopReason !== 'end_turn') {
      update({
        transcript: appendNotice(state.transcript, `Turn ${stopReason}.`, new Date().toISOString()),
      })
    }

    await refreshChunks()
    await reviewIfChanged(before)
    await refreshAnnotations()
    await refreshHidden()
    update({ status: 'idle', diffRevision: state.diffRevision + 1 })
  }
}
