/**
 * The domain vocabulary. Zero I/O, zero dependencies on any adapter.
 *
 * These types used to live inside the modules that produced them — FileDelta in the git
 * layer, AdjudicationPayload in the model layer — which forced pure policy (the risk bar)
 * and the UI to import from infrastructure to say what they operate on. Everything now
 * depends downward onto this file instead.
 */

import type { Queued } from './queue.ts'

export type { Queued }

export type LifecycleStatus = 'Modified' | 'Created' | 'Dropped'

export type Hunk = { startLine: number; endLine: number }

/** An opaque handle to a captured tree state. Git happens to make these SHAs. */
export type SnapshotId = string

/**
 * A root the session knows about, for display — not the full `RootHandle` (`ports.ts`), which
 * carries live port instances that have no business leaving `app/`.
 */
export type RootInfo = { root: string }

/** Whether the project directory can be tracked at all. Only `'git'` can open a session:
 *  `'not-git'` has no repository to record a baseline in. */
export type RepoStatus = 'git' | 'not-git'

export type FileDelta = {
  path: string
  /** Set only for renames: the path the file moved from. */
  previousPath?: string
  status: LifecycleStatus
  /** A rename with no content change. The risk bar treats these as mechanical. */
  pureRename: boolean
  binary: boolean
  hunks: Hunk[]
  /** Content of changed lines, used by the risk bar. Never leaves the process. */
  addedLines: string[]
  removedLines: string[]
}

/**
 * How hazardous the review judges a change to be.
 *
 * An enum rather than a scalar: models emit enums far more reliably than calibrated
 * floats, and `none` needs to be an unmistakable first-class answer. "This is safe" is
 * an expected outcome, not a failure to find something.
 */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

/**
 * A parsed unified diff.
 *
 * The renderer works from this rather than from raw patch text, so git plumbing
 * (`diff --git`, `index abc..def`, `---`/`+++`) never reaches the page, and every line
 * carries the numbers a reader needs to find it in their editor.
 */

type PatchLineKind = 'add' | 'remove' | 'context'

export type PatchLine = {
  kind: PatchLineKind
  /** Line number on the old side, or null for an addition. */
  oldLine: number | null
  /** Line number on the new side, or null for a removal. */
  newLine: number | null
  text: string
}

export type PatchHunk = {
  oldStart: number
  newStart: number
  /** The function/class context git puts after the `@@`, when it found one. */
  context: string
  lines: PatchLine[]
}

export type PatchKind = 'modified' | 'created' | 'deleted' | 'renamed' | 'binary'

export type ParsedPatch = {
  kind: PatchKind
  path: string
  previousPath?: string
  addedCount: number
  removedCount: number
  hunks: PatchHunk[]
}

/**
 * One reviewable unit: a run of related hunks from a single file.
 *
 * Chunks, not files, are what get analyzed and cached. A file-sized unit means one edit
 * anywhere in a large file invalidates the whole file's analysis, and one claim covering
 * dozens of unrelated changes is a poor thing to adjudicate.
 */
export type Chunk = {
  /** Stable content identity. See `chunkKey` — deliberately excludes line numbers and root. */
  key: string
  /** Which root this chunk belongs to — see `RootHandle` in `ports.ts`. Stamped on by
   *  `board.ts`'s `chunksOf`, never part of `key` itself (see `chunkKey`'s doc comment). */
  root: string
  path: string
  previousPath?: string
  kind: PatchKind
  /** Region in new-file coordinates, for `diffLocation`. */
  startLine: number
  endLine: number
  addedCount: number
  removedCount: number
  hunks: PatchHunk[]
  /**
   * False when the chunk is past the analysis budget. It is still shown in full and still
   * gates — the budget governs what is sent to a model, never what the human sees.
   */
  analyzable: boolean
  /** True for a whole-file create or delete, which the UI collapses by default. */
  wholeFile: boolean
}

/** How serious one finding is. `none` is not a severity: a file with nothing wrong has no findings. */
export type Severity = 'low' | 'medium' | 'high'

/**
 * One place a change breaks a rule — in the reviewed file, or in another file it breaks (a
 * caller, a test). Built from the reviewer's typed verdicts (`core/verdicts.ts`).
 */
export type Finding = {
  path: string
  /** New-file line numbers, inclusive. */
  startLine: number
  endLine: number
  severity: Severity
  /** The name of the rule it breaks (`Rule.name`). */
  rule: string
  /** The rule's `description`: what it asks for. The reviewer judges; it writes nothing. */
  message: string
}

/**
 * The review's reading of one chunk: the findings that land on it, and the worst of their
 * severities as its level (`none` when there are none).
 */
export type ChunkAnalysis = {
  riskLevel: RiskLevel
  findings: Finding[]
}

/** What is cached for one reviewed file. */
export type FileReview = {
  findings: Finding[]
}

/** Findings on a changed file that do not land on any of its chunks. */
export type FileFindings = {
  root: string
  path: string
  findings: Finding[]
}

/** A permission choice the agent offered. */
type PermissionOption = { optionId: string; name: string; kind: string }

/** One choice offered for a clarifying question, from the `AskUserQuestion` tool. */
type QuestionOption = { label: string; description: string }

/** One clarifying question the agent is asking, from the `AskUserQuestion` tool. A single
 *  `AskUserQuestion` call carries 1-4 of these at once, and they are answered together. */
export type AgentQuestion = {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** A past agent conversation, as offered for resuming. */
export type SessionSummary = { sessionId: string; title: string | null; updatedAt: string | null }

/**
 * Turnstile's own plan-mode status, deliberately narrower than the SDK's `PermissionMode`
 * (which also has `acceptEdits`/`bypassPermissions`/`dontAsk`/`auto` — Turnstile never sets
 * those itself). Keeping this local rather than re-exporting the SDK's type means `core` never
 * needs to import the SDK package, matching the layering rule that already caught and fixed one
 * such leak (see `SessionStore`'s `sessionId` in the "Known gaps" notes).
 */
export type PlanModeStatus = 'default' | 'plan'

/**
 * A plan the agent has submitted via `ExitPlanMode`, awaiting a human decision. Not a chunk or
 * a diff — approving or rejecting it never touches the risk-bar/chunk machinery.
 *
 * `notes` are the line-anchored objections written against this plan, and they are **ephemeral**:
 * they live here, in memory, and go when the round is decided. File notes persist because they
 * outlive the turn that prompted them and have to survive a restart; a plan note has exactly one
 * destination and one moment — the refusal it is about to become — and the plan text itself is
 * not persisted either, so there would be nothing for a surviving note to point at.
 *
 * They are `Annotation`s rather than a type of their own so the document surface renders them
 * with the cards it already has. `root` is empty and `path` is `PLAN_PATH`: a plan is not a file,
 * and nothing may resolve those against the filesystem.
 */
export type PlanReviewState = {
  plan: string
  round: number
  notes: Annotation[]
  /**
   * Recovered from a resumed session rather than submitted by a live agent.
   *
   * The difference is who is listening. A live plan is a `canUseTool` call held open, and the
   * decision is its return value. A recovered one is a plan the session died in the middle of —
   * that call is long gone, so the decision has to reach the agent as the next thing said to it
   * instead. Everything the reader does is identical either way; only the delivery differs.
   */
  recovered: boolean
}

/**
 * What the agent did, as the session sees it.
 *
 * Deliberately protocol-free: `app/` reasons about assistant text and completed edits, not
 * about `session/update` notifications, so swapping the transport again would not reach past
 * the adapter that produces these.
 */
export type AgentEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind: string; status: string }
  | {
      kind: 'subagent'
      taskId: string
      toolUseId: string | null
      /** `null` asserts no change — `task_updated`'s patch may omit `status` entirely. */
      status: string | null
      description: string | null
      subagentType: string | null
      lastToolName: string | null
      toolUses: number | null
      summary: string | null
    }
  | {
      kind: 'permission'
      id: string
      title: string
      /** The command/URL/path actually under question — see `core/permissionPrompt.ts`. */
      subject: string | null
      /** The agent's own account of what it is doing, when it gave one. */
      description: string | null
      /** Why this call needed a human rather than auto-approving. */
      reason: string | null
      options: PermissionOption[]
    }
  | { kind: 'permission-resolved'; id: string }
  | { kind: 'question'; id: string; questions: AgentQuestion[] }
  | { kind: 'question-resolved'; id: string }
  | { kind: 'agent-error'; message: string }
  | { kind: 'config-update'; model: string | null; thinkingLevel: string | null }
  | { kind: 'usage-update'; contextUsed: number; contextSize: number }
  | { kind: 'plan-mode-update'; mode: PlanModeStatus }
  /** A plan recovered from a resumed session's history, with what was decided about it. The
   *  live path does not use this — `requestPlanApproval` records the plan itself. */
  | {
      kind: 'plan'
      text: string
      round: number
      /**
       * `standing` is the plan still on the table when the session ended — never answered, or
       * sent back and never replaced. It comes back as a decision rather than as a record.
       */
      outcome: 'approved' | 'sent-back' | 'standing'
    }

/**
 * How a notice should read.
 *
 * Notices are the punctuation of a session — a turn ending, a verdict, a failure — and they
 * are what tells one review cycle from the next in a column of otherwise uniform text. The
 * tone is deliberately about weight rather than about the gate, so a transcript entry does
 * not have to know what a checkpoint is.
 */
export type NoticeTone = 'info' | 'good' | 'warn' | 'bad'

/** A note as the conversation shows it, once it has gone to the agent. */
export type SentNote = {
  path: string
  line: number
  rangeStart: number
  side: 'old' | 'new'
  lineText: string
  body: string
}

/** One line of the conversation, after consecutive chunks have been merged. */
export type TranscriptEntry =
  | {
      kind: 'user'
      /** What the person typed. Empty when they sent notes and nothing else. */
      text: string
      at: string
      /** Notes that went with this message, as the person wrote them — shown with it, so the
       *  conversation says what was asked rather than just that notes went. */
      notes?: SentNote[]
    }
  | { kind: 'assistant'; text: string; at: string }
  | { kind: 'thought'; text: string; at: string }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind: string
      status: string
      at: string
      /** Set once the call reaches a terminal status; null while still in flight. */
      endedAt: string | null
    }
  | {
      kind: 'subagent'
      taskId: string
      toolUseId: string | null
      status: string
      description: string | null
      subagentType: string | null
      lastToolName: string | null
      toolUses: number | null
      summary: string | null
      at: string
      /** Set once the task first reaches a terminal status; null while still running. */
      endedAt: string | null
    }
  | {
      /**
       * A plan the agent submitted, and what was decided about it.
       *
       * The plan tab is the live surface and it is transient — it goes the moment the decision
       * is made. Without this the plan went with it: approving one erased the thing you had
       * just agreed to, and resuming the session showed a bare `ExitPlanMode` tool row with the
       * text thrown away. A plan is the most consequential thing in a session; it belongs in the
       * record of that session.
       */
      kind: 'plan'
      text: string
      /** Which attempt this was, so a revised plan reads as a revision rather than a repeat. */
      round: number
      outcome: 'approved' | 'sent-back'
      at: string
    }
  | { kind: 'notice'; text: string; tone: NoticeTone; at: string }

export type SessionStatus = 'starting' | 'idle' | 'working'

/** A question the agent is blocked on. The turn cannot proceed until it is answered. */
export type PendingPermission = {
  id: string
  title: string
  /** The command/URL/path under question, quoted verbatim for the reader. Null when the call
   *  has nothing worth quoting — see `core/permissionPrompt.ts`. */
  subject: string | null
  description: string | null
  reason: string | null
  options: PermissionOption[]
}

/** A set of clarifying questions (from one `AskUserQuestion` call) the agent is blocked on.
 *  The turn cannot proceed until every question in it is answered. */
export type PendingQuestion = { id: string; questions: AgentQuestion[] }

/**
 * Everything about a live session that anyone outside it needs.
 *
 * A terminal session is a stream you read once and lose. This is the same information held
 * as state you can come back to, which is the premise of the whole app.
 */
export type SessionState = {
  status: SessionStatus
  /** The live conversation's id — also what names its baseline and its notes. */
  sessionId: string
  transcript: TranscriptEntry[]
  permissions: PendingPermission[]
  /** Clarifying questions from `AskUserQuestion`, kept separate from `permissions` since their
   *  shape (nested per-question options, optional multi-select) doesn't fit the flat
   *  single-choice prompt the rest of `canUseTool` produces. */
  questions: PendingQuestion[]
  /** Bumped on every change, so a client can tell whether what it holds is current. */
  revision: number
  /**
   * Bumped when the working tree changes. The diff itself is fetched separately rather than
   * carried here: it is large, it changes often, and most changes to session state have
   * nothing to do with it.
   */
  diffRevision: number
  /**
   * The board: every change in the checkout since the session's baseline, one entry per chunk,
   * with how far the review has got with it.
   *
   * Carried in state rather than fetched: these are small, and the sidebar's whole job is
   * to show them changing. Nothing is decided here — a chunk is on the board exactly as long as
   * it differs from the baseline.
   */
  chunks: LiveChunk[]
  /** Review findings on changed files that land on none of their chunks — unchanged code, or
   *  another file the change affects. One entry per file that has any. */
  fileFindings: FileFindings[]
  /** The live session's root — the repository's top level — as a one-element list, or empty before a session
   *  has opened. See `RootRegistry`. */
  roots: RootInfo[]
  /**
   * Whether the project can be tracked. Anything but `'git'` means no session was opened: the
   * UI asks to initialize a repository (`Session.initRepository`). `'unknown'` until `start()`
   * has checked.
   */
  tracking: RepoStatus | 'unknown'
  /** Where the board is measured from, once the session is open — see `BaselineSource`. */
  baseline: BaselineSource | null
  /**
   * Notes left on lines, including ones already handed to the agent.
   *
   * Sent notes stay: they are the record of what you asked for, and hiding them the moment
   * they are delivered is the vanishing act the board exists to stop.
   */
  annotations: Annotation[]
  /**
   * Changed files the reader has hidden from the tab strip, having read them. A file stays here
   * only until its content changes — the agent editing it again brings it back (`HiddenFile`).
   */
  hidden: FileRef[]
  /**
   * What was typed while the agent was busy, waiting to be handed over.
   *
   * Not sent as it is written: interrupting a turn mid-flight is how you get half-finished
   * work. It goes as the next turn, once the one in flight ends.
   */
  queued: Queued[]
  /** The coding agent's currently selected model, from the ACP session's own config options. */
  model: string | null
  /** The agent's reasoning/thinking effort level, same source as `model`. */
  thinkingLevel: string | null
  /** Tokens currently in the agent's context window, from the ACP protocol's usage updates. */
  contextUsed: number | null
  /** The agent's total context window size in tokens. */
  contextSize: number | null
  /** Whether the agent is currently restricted to planning (no tool execution) or free to act. */
  planMode: PlanModeStatus
  /** Present only while a submitted plan is awaiting a human decision — the turn is blocked on
   *  the agent's `ExitPlanMode` call until this resolves. */
  planReview: PlanReviewState | null
}

/**
 * A note left on one or more lines of a changed file.
 *
 * Anchored to the file and line, not to a chunk: the board is a plain diff against the baseline,
 * so a line is the only thing a note can be about that still means something after the agent
 * rewrites the code around it. `lineText` keeps the line(s) as they read when the note was
 * written, so a note whose code has since moved or changed can still say what it was about.
 *
 * Notes are the session's, not a turn's: they survive a resume the same way the diff does, and
 * go to the agent only when the human sends them (`Session.sendNotes`).
 */
export type Annotation = {
  id: string
  /** The conversation this note belongs to — the store's only partition key. */
  sessionId: string
  /** The root (repository top level) the note's file lives in. */
  root: string
  path: string
  /** New-side line number where possible; the old side for a removed line. This is the *last*
   *  line of the range for a note left on more than one line — see `rangeStart`. */
  line: number
  /** The first line of the range this note is about, same numbering scheme as `line`. Equal to
   *  `line` for a note on a single line. */
  rangeStart: number
  side: 'old' | 'new'
  /** The line(s) as they read when the note was written — one per line in the range, joined by
   *  a newline, oldest (lowest-numbered) first. */
  lineText: string
  body: string
  at: string
  /** When it was handed to the agent, or null while it is still yours alone. */
  sentAt: string | null
  /** `contentHash` of the whole file when the note was written. Any change to the file after
   *  that clears the note (`staleNotes`), since its line numbers no longer point where they did.
   *  Absent on notes written before this existed, which are left alone. */
  fileHash?: string
}

/** One file, by root and path. */
export type FileRef = { root: string; path: string }

/**
 * A changed file the reader has hidden, having finished with it.
 *
 * Hidden only as the file stood then: `fileHash` is the whole file's `contentHash` when it was
 * hidden, and any change after that shows it again (`changedSince`) — new work on a file is
 * never something the reader has already read.
 */
export type HiddenFile = {
  /** The conversation this belongs to — the store's only partition key. */
  sessionId: string
  root: string
  path: string
  fileHash: string
  at: string
}

/**
 * Where the board is measured from.
 *
 * - `session-start`: the checkout's tree recorded at the session's first prompt, before the agent
 *   could act (`refs/turnstile/baselines/<sessionId>`). The normal answer.
 * - `head`/`empty`: nothing better could be found.
 */
export type BaselineSource = 'session-start' | 'head' | 'empty'

/**
 * How far the review has got with one chunk.
 *
 * `pending` and `analyzing` are distinct on purpose: the first says the work is queued, the
 * second that something is actually happening. Collapsing them would make a queue behind a
 * slow chunk look identical to a stall.
 */
type ChunkStatus = 'pending' | 'analyzing' | 'ready' | 'skipped'

/**
 * A chunk as it exists right now, analysed or not.
 *
 * These appear the moment an edit lands, before anything has looked at them. That is the
 * point: the list is a picture of what changed, and the review filling in behind it is
 * visible progress rather than a wait with nothing on screen.
 */
export type LiveChunk = {
  /**
   * Cross-root live identity — `boardKey(root, contentKey)` (`core/chunking.ts`), collision-safe
   * across roots. This is the wire-facing value the UI keys chunks by.
   */
  key: string
  /**
   * The bare storage identity — what `chunkKey()` actually computed, before `boardKey` folded
   * `root` in — what the analysis cache is keyed by. `boardKey` is one-way, so this is not
   * recoverable from `key` alone.
   */
  contentKey: string
  /** Which root this chunk belongs to — see `RootHandle` in `ports.ts`. */
  root: string
  path: string
  previousPath?: string
  startLine: number
  endLine: number
  kind: PatchKind
  status: ChunkStatus
  /** Present once the review has answered. */
  analysis: ChunkAnalysis | null
  /** Why it will never be analysed, when `status` is `skipped`; why the last attempt failed,
   *  when it is `pending` (see `markFailed`). */
  reason: string | null
}

/** A file's changes, ready to render. */
export type DiffFile = {
  /** Which root this file belongs to — see `RootHandle` in `ports.ts`. */
  root: string
  path: string
  previousPath?: string
  status: LifecycleStatus
  patch: ParsedPatch
}

/**
 * What changed, and against what.
 *
 * The thing a terminal cannot give you: not a diff that scrolled past, but the diff as it
 * stands right now, still there when you look up.
 */
export type DiffView = {
  /**
   * The tree this is measured against.
   *
   * The live session's repository only — there is never more than one root.
   */
  base: string
  files: DiffFile[]
  /** Set when the diff could not be computed, so the pane can say why. */
  error: string | null
  /** The checkout's branch, from the baseline resolution. */
  branch: string | null
}
