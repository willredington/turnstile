import type {
  AgentEvent,
  Annotation,
  BaselineSource,
  DiffView,
  FileDelta,
  FileRef,
  Finding,
  HiddenFile,
  PatchKind,
  PlanModeStatus,
  RepoStatus,
  SessionState,
  SessionSummary,
  SnapshotId,
  StoredReview,
} from './types.ts'

/**
 * One root Turnstile is tracking: the repository the live session works in, whose
 * snapshots/diffs are git trees.
 *
 * `root` is always an absolute path — the repository's top level.
 */
export type RootHandle = {
  root: string
  snapshots: SnapshotStore
  baseline: Baseline
}

/**
 * The root the live session works in.
 *
 * There is exactly one at a time: the repository Turnstile was launched in, bound to the live
 * session so its baseline is that session's. It used to be a set of roots discovered
 * mid-session and coalesced when a shallower one turned up, including Turnstile-owned
 * "synthetic" roots for directories with no git at all. Nearly every change-detection bug came
 * from that machinery: the agent works inside one git checkout, and anything it writes outside
 * that checkout is refused rather than tracked.
 */
export interface RootRegistry {
  /** The active root as a one-element list, or empty before any session has opened. Kept a
   *  list so every "for each root" consumer stays unchanged. Synchronous: no I/O of its own. */
  knownRoots(): RootHandle[]
  /** Make `root` (the repository's top level) the active root for `sessionId`, replacing any
   *  previous one. The session id is what its baseline is found by. */
  activate(root: string, sessionId: string): RootHandle
  /** Forget the active root: a new session has none until its first prompt. */
  deactivate(): void
  /** The active root's handle when `absolutePath` lies inside it, otherwise null. */
  rootFor(absolutePath: string): RootHandle | null
  /** Called once, at shutdown. Forgets the active root. */
  teardown(): Promise<void>
}

/** Where an opened session works. */
export type OpenedSession = {
  /** The repository's top level. */
  root: string
  /** Where the agent runs — the directory Turnstile was launched in. */
  cwd: string
}

/**
 * The git repository Turnstile was launched in, and each session's baseline within it. Bound to
 * that directory at construction.
 *
 * Every session works directly in the user's checkout. Git itself is the record of which
 * sessions exist (`refs/turnstile/baselines/<sessionId>`), so nothing about this is persisted by
 * Turnstile.
 */
export interface Repository {
  status(): Promise<RepoStatus>
  /** `git init` plus an initial commit of what is already there. */
  init(): Promise<void>
  /**
   * Open `sessionId` in the checkout. The first time, the checkout's tree as it stands —
   * uncommitted and untracked work included — is recorded as the session's baseline, in git
   * (`refs/turnstile/baselines/<sessionId>`), so the board is measured from the point the
   * session started for good — across restarts and resumes alike. Later calls keep it.
   */
  open(sessionId: string): Promise<OpenedSession>
  /** Every session with a recorded baseline, in no particular order. */
  sessionIds(): Promise<string[]>
}

/**
 * The interfaces the pipeline needs from the outside world.
 *
 * Each is bound to its working directory at construction by the composition root, so
 * nothing downstream has to thread a `cwd` through every call — a port describes a
 * capability, not a location.
 */

/**
 * A live conversation with a coding agent.
 *
 * Named as a capability rather than as ACP, because nothing above this layer should care
 * which protocol carries it. The agent runs its own commands and its own file I/O, so there
 * is deliberately nothing here for executing or reading — only talking.
 */
export interface AgentConnection {
  /**
   * Open a fresh conversation under `sessionId`, chosen by the caller so the session's baseline
   * can be recorded before the agent exists. Returns the same id.
   */
  start(sessionId: string): Promise<string>
  /**
   * Replay a past session's full history through `onEvent`, then return its id.
   *
   * The events arrive before this resolves, over the same channel a live turn's do — nothing
   * downstream has to know a replay is happening rather than a turn in progress.
   */
  loadSession(sessionId: string): Promise<string>
  /** Runs a turn to completion; resolves with the stop reason. */
  prompt(text: string): Promise<string>
  cancel(): Promise<void>
  /** Answer a permission request. Unknown ids are ignored. */
  answerPermission(id: string, optionId: string): void
  /**
   * Answer a pending `AskUserQuestion` request. Unknown ids are ignored. `answers` maps each
   * question's `question` text to the label(s) selected for it — a single string for a
   * single-select question, an array of strings for a multi-select one, or free text typed in
   * place of any offered option.
   */
  answerQuestion(id: string, answers: Record<string, string | string[]>): void
  /**
   * Switch the underlying agent's permission mode. Only meaningful in `'plan'`/`'default'` —
   * see `PlanModeStatus`. Streaming-input only, which is the only mode this connection ever
   * runs in.
   */
  setPermissionMode(mode: PlanModeStatus): Promise<void>
  stop(): void
}

/**
 * Past conversations the agent has recorded in the project directory, readable with no live
 * connection — a session's agent is not started until its first prompt, but the resume picker
 * needs the list before that. Bound to that directory at construction.
 */
export interface AgentHistory {
  /** Past sessions recorded for the project directory, newest first. Empty when the agent
   *  cannot list them. */
  listSessions(): Promise<SessionSummary[]>
}

/**
 * `writeFile` is the shared write path the connection's in-process tool calls into — the only
 * way to touch a file, now that native `Edit`/`Write` are disallowed. Handed in rather than
 * reached for, so the adapter that builds the tool never has to reason about gating: it only
 * calls this and reports whatever it gets back.
 *
 * `requestPlanApproval` is the same shape of indirection for the SDK's built-in `ExitPlanMode`
 * tool: the adapter recognizes the tool by name and reads the plan text straight off its
 * input (confirmed present there live, despite the SDK's own type defs only documenting a
 * deprecated field), but never decides anything about it — deciding belongs to `app/`, same as
 * every other gate.
 */
export type AgentConnectionFactory = (
  onEvent: (event: AgentEvent) => void,
  writeFile: (input: {
    path: string
    oldText: string | null
    newText: string
  }) => Promise<
    { decision: 'allow'; fileContent: string } | { decision: 'reject'; reasoning: string }
  >,
  requestPlanApproval: (
    plan: string,
  ) => Promise<{ decision: 'allow' } | { decision: 'reject'; reasoning: string }>,
  /** Where the agent runs: the directory Turnstile was launched in. Fixed for the connection's
   *  lifetime. */
  cwd: string,
) => AgentConnection

/**
 * A live session, as the transport sees it.
 *
 * A port rather than a concrete type so the server and the browser bundle depend on the
 * capability instead of on `app/` — the boundary that keeps the UI from growing opinions
 * about how a turn is run.
 */
/** What became of a save the reader asked for. */
export type SaveResult = { ok: true } | { ok: false; reason: string }

export interface Session {
  state(): SessionState
  /** What has changed since the session's baseline. Computed on demand. */
  diff(): Promise<DiffView>
  /**
   * Prepare the first session. Its baseline and agent are not created until its first prompt, so
   * an app start that never sends one leaves nothing behind. When the project is not a usable
   * git repository this only records that (`SessionState.tracking`) — see `initRepository`.
   */
  start(): Promise<void>
  /** `git init` an untracked project (with an initial commit), then `start()`. A no-op when the
   *  project is already tracked. */
  initRepository(): Promise<void>
  /**
   * Leave the live session and open a fresh conversation.
   *
   * Refuses — throws — while a turn is running: switching away mid-turn would abandon an
   * in-flight prompt.
   */
  newSession(): Promise<void>
  /**
   * Leave the live session and replay a past conversation in its place.
   *
   * Same refusal as `newSession`. The replayed history arrives in the transcript the same way
   * a live turn's events do, and the board is measured from the conversation's own baseline —
   * everything that has changed since it started — with its notes still in place.
   */
  resumeSession(sessionId: string): Promise<void>
  /** Past sessions for this project, newest first — for a "resume…" picker. */
  listSessions(): Promise<SessionSummary[]>
  /** Runs a turn: prompt, stream, refresh the board. Resolves when the turn is over. Notes are
   *  never carried by this — only by `sendNotes`. */
  send(text: string): Promise<void>
  /**
   * Hand every unsent note to the agent, with `text` (if any) after them — the one way a note
   * ever reaches the agent. While a turn is running, the notes as they stand now (and the text)
   * go as the next turn, once this one ends.
   */
  sendNotes(text?: string): Promise<void>
  answerPermission(id: string, optionId: string): void
  /** Answer a pending `AskUserQuestion` request — see `AgentConnection.answerQuestion`. */
  answerQuestion(id: string, answers: Record<string, string | string[]>): void
  /**
   * The one path a file's contents change through during a session — native `Edit`/`Write`
   * are disallowed, so this is the only way. Called by the agent connection's in-process write
   * tool, once per tool call. Writes immediately; the board picks it up from the tree.
   */
  writeFile(input: {
    path: string
    oldText: string | null
    newText: string
  }): Promise<
    { decision: 'allow'; fileContent: string } | { decision: 'reject'; reasoning: string }
  >
  /**
   * Say something while the agent is busy, to be handed over when its turn ends. Not an
   * interrupt: cutting into a turn mid-flight is how you get half-finished work. Delivered
   * immediately if nothing is running.
   */
  queue(text: string, where?: string): void
  /** Withdraw a queued message, for the one you regret before it has gone anywhere. */
  unqueue(id: string): void
  /** Leave a note on one or more lines of a changed file. It stays with the session until
   *  `sendNotes`. `rangeStart` defaults to `line` (a single-line note) when omitted. */
  annotate(input: {
    root: string
    path: string
    line: number
    rangeStart?: number
    side: 'old' | 'new'
    lineText: string
    body: string
  }): Promise<void>
  removeAnnotation(id: string): Promise<void>
  /** Hide a changed file from the tab strip until its content next changes. */
  /**
   * Write a file the reader edited themselves.
   *
   * Deliberately separate from the agent's write path. `runToolWrite` exists to hold the
   * *agent* to its `old_text` and to the repository; a human typing in their own checkout is
   * subject to neither. What the two share is the aftermath — the board, the review and note
   * staleness all have to be told an edit landed.
   *
   * Reports what happened rather than returning nothing: the caller clears its
   * unsaved-changes marker on success, so a refusal that looked like a save would tell the
   * reader their work is on disk when it is not.
   */
  saveFile(file: FileRef, text: string): Promise<SaveResult>
  hideFile(file: FileRef): Promise<void>
  /** Bring a hidden file back before it changes. */
  showFile(file: FileRef): Promise<void>
  /**
   * Review every changed file with no current review — never reviewed, or changed since. The
   * review otherwise runs only at the end of a turn that changed something, so this is how the
   * board catches up with changes made any other way: by hand, a checkout, another session.
   */
  reviewNow(): void
  /**
   * Restrict the agent to planning — no tool execution — until a submitted plan is approved or
   * plan mode is explicitly exited. Refuses mid-turn, the same way `newSession` does.
   */
  enterPlanMode(): Promise<void>
  /** Leave plan mode without going through a plan submission — same refusal as `newSession`. */
  exitPlanMode(): Promise<void>
  /** Approve the plan currently awaiting a decision (`state().planReview`). Ignored if none is
   *  pending. */
  approvePlan(): void
  /** Reject the plan currently awaiting a decision. The agent sees the pending plan's notes and
   *  `feedback`, written out by `planRefusal`, as this turn's `ExitPlanMode` call result.
   *  Ignored if none is pending, or if there is neither a note nor any feedback. */
  rejectPlan(feedback: string): void
  /**
   * Leave a note on lines of the plan currently awaiting a decision. Ignored if none is pending.
   *
   * Synchronous, and far thinner than `annotate`: a plan note is never stored, never hashed
   * against a file and never resolved against a root, because a plan is not a file. It lives on
   * `state().planReview` until the round is decided and then goes with it.
   */
  annotatePlan(input: { rangeStart: number; line: number; lineText: string; body: string }): void
  /** Withdraw one of the pending plan's notes. Ignored if none is pending, or if no note on it
   *  has that id. */
  removePlanNote(id: string): void
  cancel(): Promise<void>
  stop(): void
}

/**
 * Where the board starts, and how that was decided.
 *
 * `source` is carried because the answer is worth stating: a reader looking at a board that
 * seems too large needs to know whether it is measured from where the session opened, or from
 * nothing at all because that starting point could not be found.
 */
export type BaselineResolution = {
  tree: SnapshotId
  source: BaselineSource
  /** The checkout's branch, or null on a detached HEAD. */
  branch: string | null
}

/**
 * The tree everything is measured against: the checkout as it stood when the session started
 * (see `Repository.open`), falling back to HEAD, then nothing.
 *
 * Deliberately has no `advance`: there is no pointer to move and none to reset. Everything in
 * the checkout that differs from this — committed or not, whoever made it — is on the board.
 */
export interface Baseline {
  resolve(): Promise<BaselineResolution>
}

/**
 * Captures tree states and compares them, as git trees (`adapters/git`).
 *
 * A snapshot is a tree written through a scratch index, so capturing never touches the user's
 * index, HEAD or history, and a commit the agent makes cannot hide its work from the board.
 */
export interface SnapshotStore {
  /** Capture the working tree as it stands now. */
  capture(): Promise<SnapshotId>
  delta(base: SnapshotId, next: SnapshotId): Promise<FileDelta[]>
  patch(base: SnapshotId, next: SnapshotId, path: string, previousPath?: string): Promise<string>
  /**
   * The full text of a file at a tree state, or null when it does not exist there.
   *
   * Distinct from `patch` because ACP's native diff block carries whole-file old and new
   * text and lets the editor render the comparison itself — it is not a unified patch. The
   * text is returned byte-exact, trailing newline included, since trimming it would show
   * the reader a change at the end of the file that nobody made.
   */
  contents(snapshot: SnapshotId, path: string): Promise<string | null>
}

/**
 * Reviews the files a session changed, in one pass (`adapters/agent-sdk/reviewer.ts`).
 *
 * A standard review by a read-only coding agent, run in the checkout, so the repository's own
 * conventions — its `CLAUDE.md`, its skills — are what it reviews against. It sees every file
 * under review at once, with the rest of the repository in reach, since whether a change is
 * right often turns on something outside it: a caller, a test, the sibling it should have
 * followed.
 */
export interface Reviewer {
  /**
   * Every path in `input.files` has an entry in the result, empty when the reviewer found
   * nothing — a review with no findings is still a review. A finding may sit in any file (a
   * caller the change broke); it is listed under the reviewed file whose change caused it.
   */
  review(input: ReviewInput): Promise<Map<string, Finding[]>>
}

export type ReviewInput = {
  root: string
  /** The changed files to review. Never empty. */
  files: ReviewedFile[]
  /** Their unified diff against the session's baseline — possibly truncated, and saying so. */
  diff: string
}

export type ReviewedFile = {
  path: string
  previousPath?: string
  kind: PatchKind
}

/**
 * Answers ONE question about ONE file, and changes nothing (`adapters/model/asker.ts`).
 *
 * Deliberately not the coding agent. Two reasons, and both matter: it cannot answer while it is
 * mid-turn — which is exactly when you are reading its output and want to ask — and a question
 * about the work is not the work, so it should not cost the agent's context window. It gets a
 * read-only `RepoReader`, so an answer can check a caller or a type definition instead of
 * guessing from the selection alone.
 *
 * Read-only by construction: the implementation is given read tools and no others, rather than
 * being given write tools and told not to use them.
 */
export interface Asker {
  ask(input: AskRequest): Promise<string>
}

export type AskRequest = {
  root: string
  /** What the model is shown, already bounded and numbered (`core/ask.ts`'s `askPayload`). */
  payload: string
  /** The rest of the repository, read-only. */
  reader: RepoReader
}

export type GrepMatch = { path: string; line: number; text: string }

/**
 * A read-only view of the repository, for the asker's tools (`adapters/fs/repoReader.ts`).
 * Every path is relative to `root` and refused if it leaves it; every result is capped, so a
 * careless query costs a truncated answer, never an enormous prompt.
 */
export interface RepoReader {
  read(root: string, path: string): Promise<string | null>
  glob(root: string, pattern: string): Promise<{ paths: string[]; truncated: boolean }>
  grep(
    root: string,
    pattern: string,
    glob?: string,
  ): Promise<{ matches: GrepMatch[]; truncated: boolean }>
}

/**
 * Each session's file reviews, so a resumed session shows its last review again
 * (`adapters/fs/findings.ts`). Keyed by session, like notes; whether a stored review still
 * applies is the session's call, by its `fileHash`.
 */
export interface FindingStore {
  bySession(sessionId: string): Promise<StoredReview[]>
  /** Store these reviews, replacing any earlier one for the same session, root and path. */
  put(sessionId: string, reviews: StoredReview[]): Promise<void>
}

/**
 * The working tree, for the one thing Turnstile writes to it: the agent's write tool
 * (`Session.writeFile`). Also read to fingerprint a noted or hidden file, so a note can be
 * cleared, or a hidden file shown again, once its file changes (`core/annotations.ts`'s
 * `changedSince`).
 *
 * Deliberately tiny. Turnstile reads the tree through snapshots; this exists only for those
 * two uses, and it should not grow into a filesystem.
 */
export interface EditTarget {
  read(root: string, path: string): Promise<string | null>
  write(root: string, path: string, text: string): Promise<void>
}

/**
 * What a browsable file turned out to hold: its text, or a refusal to treat it as text at all.
 *
 * Binary is a distinct answer rather than an error or an empty string because it is neither —
 * the file is there and readable, it just has no lines to render, and a caller needs to say so
 * rather than show a blank document. See `core/binary.ts` for what makes a file binary and
 * why a line-rendering surface must never be handed one.
 */
export type FileContents = { kind: 'text'; text: string } | { kind: 'binary' }

/**
 * Every file in the project, for browsing rather than reviewing.
 *
 * Deliberately independent of `EditTarget`: this is a read-only tree of the whole project,
 * not the narrow read/write surface a typed edit uses — the two ports should never be
 * confused for one another the way `Workspace` and this once nearly were.
 */
export interface ProjectTree {
  /** Every non-ignored file path in one root, relative to that root, forward-slash separated.
   *  Directories are implied by path segments, not listed separately. */
  list(root: string): Promise<string[]>
  /** A file's current contents, or null if it doesn't exist, can't be read, or resolves
   *  outside `root`. */
  read(root: string, path: string): Promise<FileContents | null>
}

/**
 * Notes left on lines, and whether the agent has been told about them yet.
 *
 * Reads are scoped by session: a note belongs to the conversation it was written in, and comes
 * back with it on a resume, the same way the conversation's diff does.
 */
export interface AnnotationStore {
  bySession(sessionId: string): Promise<Annotation[]>
  add(annotation: Annotation): Promise<void>
  /** Remove one of `sessionId`'s notes. An id belonging to any other session is left alone. */
  remove(sessionId: string, id: string): Promise<void>
  /** Mark `sessionId`'s notes as delivered, so they are not sent again. Ids belonging to any
   *  other session are left alone. */
  markSent(sessionId: string, ids: string[], at: string): Promise<void>
  /** Undo `markSent` for notes whose delivery failed (the agent's process died before the turn
   *  finished), so they can be sent again. Ids belonging to any other session are left alone. */
  markUnsent(sessionId: string, ids: string[]): Promise<void>
}

/**
 * Changed files the reader has hidden, each with the file's fingerprint at the time.
 *
 * Scoped by session, like notes: hiding belongs to the conversation, and comes back with it on a
 * resume.
 */
export interface HiddenFileStore {
  bySession(sessionId: string): Promise<HiddenFile[]>
  /** Hide a file, replacing any earlier entry for the same session, root and path. */
  hide(entry: HiddenFile): Promise<void>
  /** Show one of `sessionId`'s hidden files again. Nothing happens if it is not hidden. */
  show(sessionId: string, root: string, path: string): Promise<void>
}

/** What may be attached to a measurement. Deliberately flat and primitive: these become
 *  OpenTelemetry attributes, which are dimensions on a metric, not a place for payloads. */
export type Attributes = Record<string, string | number | boolean>

/**
 * Where Turnstile's own measurements go (`adapters/otel/telemetry.ts`).
 *
 * Only Turnstile's half. The agent's spans, tokens and cost come from the Claude Code CLI's
 * own OpenTelemetry instrumentation, which needs configuration rather than code — see
 * `agentTelemetryEnv` in `core/telemetry.ts`.
 *
 * The contract that matters is that measuring changes nothing: `span` returns the work's own
 * result and lets its failures through untouched, and no method here may throw. A session run
 * with the no-op must behave exactly like one run against a live collector.
 */
export interface Telemetry {
  /** Time `work`, tagging the span with `attrs`. Returns whatever `work` returned. */
  span<T>(name: string, attrs: Attributes, work: () => Promise<T>): Promise<T>
  /** Add to a counter — how often something happened. */
  count(name: string, attrs?: Attributes, value?: number): void
  /**
   * Record one observation in a distribution: a duration measured somewhere Turnstile does not
   * control the call (the browser's keystroke latency), or a size worth a histogram.
   */
  record(name: string, value: number, attrs?: Attributes): void
  /** Push anything buffered to the collector. Called before the process exits. */
  flush(): Promise<void>
}
