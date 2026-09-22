import type { AgentEvent, NoticeTone, SentNote, TranscriptEntry } from './types.ts'

/**
 * Turning a stream of agent events into something readable.
 *
 * The agent emits text a few tokens at a time and re-announces a tool call on every status
 * change. Rendered literally that is hundreds of fragments and a dozen duplicate lines per
 * turn — which is precisely the terminal-scrollback experience this app exists to improve
 * on, faithfully reproduced in a browser.
 *
 * So: consecutive text of the same kind merges into one entry, and a tool call updates the
 * line it already has rather than adding another. Pure, because the merging rules are the
 * part worth testing and they should not need a running agent to exercise — `at` is passed
 * in rather than read from the clock, for the same reason.
 */

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/**
 * Append one event, returning the new transcript. Unknown events change nothing.
 *
 * `at` is the moment this event was folded in, supplied by the caller rather than read here
 * — this file stays a pure function of its inputs. A merge into an existing streamed run (or
 * an existing tool call) keeps that run's original `at`, since `at` marks when the entry
 * started, not when it was last touched.
 */
export function appendEvent(
  entries: TranscriptEntry[],
  event: AgentEvent,
  at: string,
): TranscriptEntry[] {
  if (event.kind === 'user') return appendUser(entries, event.text, at)

  if (event.kind === 'assistant' || event.kind === 'thought') {
    const last = entries[entries.length - 1]
    if (last?.kind === event.kind) {
      return [
        ...entries.slice(0, -1),
        { kind: event.kind, text: last.text + event.text, at: last.at },
      ]
    }
    return [...entries, { kind: event.kind, text: event.text, at }]
  }

  if (event.kind === 'tool') {
    const index = entries.findIndex((entry) => entry.kind === 'tool' && entry.id === event.id)
    const terminal = event.status === 'completed' || event.status === 'failed'

    if (index < 0) {
      const line: ToolEntry = {
        kind: 'tool',
        id: event.id,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        at,
        endedAt: terminal ? at : null,
      }
      return [...entries, line]
    }

    // A later update may carry only a status, so an empty title must not blank the line the
    // reader is already looking at. `at` and an already-set `endedAt` never move once
    // recorded — they mark when the call started and when it finished, not when it was last
    // touched.
    const existing = entries[index] as ToolEntry
    const merged: ToolEntry = {
      kind: 'tool',
      id: event.id,
      title: event.title === '' ? existing.title : event.title,
      toolKind: event.toolKind === 'other' ? existing.toolKind : event.toolKind,
      status: event.status,
      at: existing.at,
      endedAt: existing.endedAt ?? (terminal ? at : null),
    }
    return entries.map((entry, i) => (i === index ? merged : entry))
  }

  if (event.kind === 'subagent') {
    const index = entries.findIndex(
      (entry) => entry.kind === 'subagent' && entry.taskId === event.taskId,
    )

    if (index < 0) {
      // A brand new sighting with no status asserted (in practice, only possible if a
      // `task_updated` patch is somehow the very first message seen for a task) still needs
      // some status to render — 'running' is the only sane assumption for a task we have no
      // prior state for.
      const status = event.status ?? 'running'
      const terminal = status === 'completed' || status === 'failed'
      const line: TranscriptEntry = {
        kind: 'subagent',
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        status,
        description: event.description,
        subagentType: event.subagentType,
        lastToolName: event.lastToolName,
        toolUses: event.toolUses,
        summary: event.summary,
        at,
        endedAt: terminal ? at : null,
      }
      return [...entries, line]
    }

    // Every field is a fresh sighting overlaid onto the last one: `task_progress` and
    // `task_updated` are partial by nature (a progress tick has no `summary`, a status patch
    // may have no `status` of its own if it only touches `description`), so a `null` here must
    // not blank out a value an earlier event already recorded. `at`/`endedAt` follow the same
    // never-move-once-set rule the `tool` branch above already uses.
    const existing = entries[index] as Extract<TranscriptEntry, { kind: 'subagent' }>
    const status = event.status ?? existing.status
    const terminal = status === 'completed' || status === 'failed'
    const merged: TranscriptEntry = {
      kind: 'subagent',
      taskId: event.taskId,
      toolUseId: event.toolUseId ?? existing.toolUseId,
      status,
      description: event.description ?? existing.description,
      subagentType: event.subagentType ?? existing.subagentType,
      lastToolName: event.lastToolName ?? existing.lastToolName,
      toolUses: event.toolUses ?? existing.toolUses,
      summary: event.summary ?? existing.summary,
      at: existing.at,
      endedAt: existing.endedAt ?? (terminal ? at : null),
    }
    return entries.map((entry, i) => (i === index ? merged : entry))
  }

  if (event.kind === 'agent-error') {
    return [...entries, { kind: 'notice', text: event.message, tone: 'bad', at }]
  }

  // Permission events drive their own UI rather than the transcript; they are answered, not
  // read back later.
  return entries
}

/** How many characters of a tool call's title a one-line display shows. */
export const BRIEF_TITLE_CHARS = 80

/**
 * A tool call's title cut down to one short line. A Bash title is the whole command, and a
 * heredoc can be pages of script — shown verbatim it buries the conversation around it. The
 * first line is kept (a heredoc's opener says what it is), whitespace collapsed, and anything
 * past `BRIEF_TITLE_CHARS` replaced with an ellipsis.
 */
export function briefTitle(title: string): string {
  const lines = title.trim().split('\n')
  const first = (lines[0] ?? '').replace(/\s+/g, ' ').trim()
  const cut = first.length > BRIEF_TITLE_CHARS ? first.slice(0, BRIEF_TITLE_CHARS).trimEnd() : first
  return cut.length < first.length || lines.length > 1 ? `${cut}…` : cut
}

/**
 * What the agent appears to be doing right now.
 *
 * The stream is silent for most of a turn: a tool reports back, then nothing arrives for
 * twenty seconds while the model decides what to do next, then more text. Rendered literally
 * that is a column that stops, which is indistinguishable from a column that has finished —
 * and the reader has no way to tell a long thought from a hung session.
 *
 * A tool that has not reported back outranks thinking, because it is the more specific
 * answer: "reading src/inventory.ts" tells you more than "thinking". Anything else during a
 * turn is the model generating, which is the only thing left it can be doing.
 *
 * Terminal statuses are named rather than the in-flight ones: the agent chooses those words,
 * and one we have not seen before must read as still running, never as silently finished.
 */
export function nowDoing(
  entries: TranscriptEntry[],
): { kind: 'tool'; title: string; toolKind: string } | { kind: 'thinking' } {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at]
    if (entry?.kind !== 'tool') continue
    if (entry.status === 'completed' || entry.status === 'failed') continue
    return { kind: 'tool', title: entry.title, toolKind: entry.toolKind }
  }
  return { kind: 'thinking' }
}

export function appendUser(
  entries: TranscriptEntry[],
  text: string,
  at: string,
  notes: SentNote[] = [],
): TranscriptEntry[] {
  return [...entries, { kind: 'user', text, at, ...(notes.length === 0 ? {} : { notes }) }]
}

/**
 * A plan, and what was decided about it.
 *
 * Recorded when the decision is made rather than when the plan arrives: until then it is on the
 * plan tab, where it can still be argued with, and a conversation entry beside it would be the
 * same document in two places disagreeing about whether it is settled.
 */
export function appendPlan(
  entries: TranscriptEntry[],
  text: string,
  round: number,
  outcome: 'approved' | 'sent-back',
  at: string,
): TranscriptEntry[] {
  return [...entries, { kind: 'plan', text, round, outcome, at }]
}

export function appendNotice(
  entries: TranscriptEntry[],
  text: string,
  at: string,
  tone: NoticeTone = 'info',
): TranscriptEntry[] {
  return [...entries, { kind: 'notice', text, tone, at }]
}

/** A run of consecutive tool calls, read as one thing rather than one line each. */
export type ToolGroupEntry = { kind: 'tool-group'; tools: ToolEntry[] }

/** One line for the reader: a transcript entry as recorded, or a run of tool calls folded
 *  into one card. */
export type ReadingEntry = { entry: TranscriptEntry | ToolGroupEntry }

/**
 * Reads the transcript the way a person does: consecutive tool calls as one group, everything
 * else as itself.
 *
 * A group of exactly one tool is not a group — it renders as a plain row, so folding never
 * costs a reader a disclosure control over a single line.
 */
export function groupForReading(entries: TranscriptEntry[]): ReadingEntry[] {
  const out: ReadingEntry[] = []
  let running: ToolEntry[] = []

  const flush = (): void => {
    if (running.length === 0) return
    out.push(
      running.length === 1
        ? { entry: running[0] as ToolEntry }
        : { entry: { kind: 'tool-group', tools: running } },
    )
    running = []
  }

  for (const entry of entries) {
    if (entry.kind === 'tool') {
      running.push(entry)
      continue
    }
    flush()
    out.push({ entry })
  }
  flush()

  return out
}

/**
 * Any member not yet reported back — the one thing about a tool run worth showing live.
 * Same completed/failed-by-exclusion convention `nowDoing` already uses.
 */
export function toolGroupIsRunning(group: ToolGroupEntry): boolean {
  return group.tools.some((tool) => tool.status !== 'completed' && tool.status !== 'failed')
}

/**
 * First member's start to last member's end — a group's duration is derived here, not
 * stored, the same way a thought's is derived from its own `at` and the next entry's.
 * `endedAt` is null while any member is still running.
 */
export function toolGroupSpan(group: ToolGroupEntry): { at: string; endedAt: string | null } {
  const first = group.tools[0] as ToolEntry
  const last = group.tools[group.tools.length - 1] as ToolEntry
  return { at: first.at, endedAt: last.endedAt }
}
