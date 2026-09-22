import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { PLAN_PATH } from '../../../core/annotations.ts'
import type { ToolGroupEntry } from '../../../core/transcript.ts'
import {
  briefTitle,
  groupForReading,
  nowDoing,
  toolGroupIsRunning,
  toolGroupSpan,
} from '../../../core/transcript.ts'
import type { NoticeTone, SessionState, TranscriptEntry } from '../../../core/types.ts'
import type { Waiting } from '../../../core/waiting.ts'
import { Chevron } from './Chevron.tsx'
import { post } from './http.ts'
import { Markdown } from './Markdown.tsx'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m ${rest}s`
}

/** The moment a reading entry starts — a group's is its first tool's, everything else's is
 *  its own `at`. Used to derive a folded thought's duration from whatever comes next. */
function entryAt(entry: TranscriptEntry | ToolGroupEntry): string {
  return entry.kind === 'tool-group' ? toolGroupSpan(entry).at : entry.at
}

/** A run's own span already carries its start and end, unlike a thought's — no "next entry"
 *  needed. Null while any member is still running. */
function toolGroupDuration(group: ToolGroupEntry): string | null {
  const { at, endedAt } = toolGroupSpan(group)
  if (endedAt === null) return null
  return formatDuration(new Date(endedAt).getTime() - new Date(at).getTime())
}

/** What to call a tool call: its title, or its kind if a status-only update hasn't carried
 *  one yet. */
function toolLabel(tool: ToolEntry): string {
  return tool.title !== '' ? briefTitle(tool.title) : tool.toolKind
}

/** One tool call's row inside an expanded run: a status mark plus its name and target. */
function ToolRow({ tool }: { tool: ToolEntry }) {
  if (tool.status === 'completed' || tool.status === 'failed') {
    return (
      <div className={`tool-row${tool.status === 'failed' ? ' failed' : ''}`}>
        <span className="tool-row-mark" aria-hidden="true">
          {tool.status === 'failed' ? '✕' : '✓'}
        </span>
        <span className="tool-row-title" title={tool.title}>
          {toolLabel(tool)}
        </span>
      </div>
    )
  }
  return (
    <div className="tool-row">
      <span className="spinner spinner-inline" aria-hidden="true" />
      <span className="tool-row-title" title={tool.title}>
        {toolLabel(tool)}
      </span>
    </div>
  )
}

/**
 * A tool call on its own, outside any run: already exactly one line, so there is nothing to
 * fold behind a click — it names what it is instead of a generic "doing work".
 */
function ToolActivity({ tool }: { tool: ToolEntry }) {
  const running = tool.status !== 'completed' && tool.status !== 'failed'
  return (
    <div className={`tool-activity${running ? ' running' : ''}`}>
      {running && <span className="spinner spinner-inline" aria-hidden="true" />}
      <span className="tool-activity-title" title={tool.title}>
        {toolLabel(tool)}
      </span>
    </div>
  )
}

/**
 * A run of tool calls, folded the same way `Thought` is: open while it's the live thing
 * happening — watching the calls land is worth something live — and one quiet line once
 * something follows it. Local override so the reader's own choice always wins over the
 * default.
 */
function ToolGroup({
  group,
  defaultExpanded,
  duration,
}: {
  group: ToolGroupEntry
  defaultExpanded: boolean
  duration: string | null
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? defaultExpanded
  const running = toolGroupIsRunning(group)
  const count = group.tools.length

  if (!expanded) {
    return (
      <button
        type="button"
        className={`tool-fold-btn${running ? ' running' : ''}`}
        onClick={() => setOverride(true)}
      >
        {running && <span className="spinner spinner-inline" aria-hidden="true" />}
        <span>
          ▸ {count} tool calls{!running && duration !== null && ` · ${duration}`}
        </span>
      </button>
    )
  }

  return (
    <div className="tool-expanded">
      <button type="button" className="tool-expanded-toggle" onClick={() => setOverride(false)}>
        ▾ {count} tool calls
      </button>
      {group.tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} />
      ))}
    </div>
  )
}

/** What to call a subagent's work: its description. The card's own kicker already says what
 *  it is, so the title is only ever the task — and until a status-only update carries a
 *  description, that a task is under way is the whole of what's known. */
function subagentLabel(entry: Extract<TranscriptEntry, { kind: 'subagent' }>): string {
  return entry.description ?? 'working…'
}

/**
 * A subagent launch, live for as long as it runs — separate from the `Agent` tool_use's own
 * quick pending/completed row, since a backgrounded subagent's real lifecycle (tracked via the
 * SDK's task_started/task_progress/task_updated/task_notification messages, see
 * `src/adapters/agent-sdk/client.ts`) can run for minutes after that row has already settled.
 * Stays a single card rather than folding, the same reasoning `ToolActivity` uses: there is
 * exactly one line's worth of live state to show, so there is nothing gained by hiding it.
 */
function SubagentActivity({ entry }: { entry: Extract<TranscriptEntry, { kind: 'subagent' }> }) {
  const running =
    entry.status !== 'completed' && entry.status !== 'failed' && entry.status !== 'stopped'
  const failed = entry.status === 'failed' || entry.status === 'stopped'
  const detail =
    entry.lastToolName === null
      ? null
      : `last: ${entry.lastToolName}${
          entry.toolUses === null
            ? ''
            : ` · ${entry.toolUses} tool call${entry.toolUses === 1 ? '' : 's'}`
        }`

  return (
    <div className={`subagent-activity${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
      {/* The kicker leads, the way `entry-agent-who` does for the agent's own prose: who is
          working has to land before what they are working on, or a card of tool-ish detail
          reads as just more tool calls. */}
      <div className="subagent-activity-who">
        {entry.subagentType === null ? 'subagent' : `subagent · ${entry.subagentType}`}
      </div>
      <div className="subagent-activity-row">
        {running ? (
          <span className="spinner spinner-inline" aria-hidden="true" />
        ) : (
          <span className="subagent-activity-mark" aria-hidden="true">
            {failed ? '✕' : '✓'}
          </span>
        )}
        <span className="subagent-activity-title">{subagentLabel(entry)}</span>
      </div>
      {detail !== null && <div className="subagent-activity-detail">{detail}</div>}
      {/* A finished subagent's summary is its report to the main agent, not to the reader —
          often pages of it — so only a failure's is shown: why it stopped is worth knowing. */}
      {failed && entry.summary !== null && (
        <div className="subagent-activity-summary">
          <Markdown text={entry.summary} />
        </div>
      )}
    </div>
  )
}

const NOTICE_WORD: Record<NoticeTone, string> = {
  good: 'done',
  warn: 'warning',
  bad: 'problem',
  info: 'note',
}

/** A band across the column, so it has no speaker: a notice is the app talking about the
 *  conversation rather than a participant in it. The tone word comes from `tone`, never
 *  from parsing `text`, so a verdict is legible without decoding a color. */
function Notice({ entry }: { entry: Extract<TranscriptEntry, { kind: 'notice' }> }) {
  return (
    <div className={`entry-notice tone-${entry.tone}`}>
      <span className="entry-notice-tone">{NOTICE_WORD[entry.tone]}</span>
      <p className="entry-notice-text">{entry.text}</p>
    </div>
  )
}

function UserBubble({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }) {
  const notes = entry.notes ?? []
  return (
    <div className="entry-user-row">
      <div className="user-bubble">
        <span className="user-bubble-label">
          you{notes.length > 0 && ` · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}
        </span>
        {entry.text !== '' && <p className="user-bubble-text">{entry.text}</p>}
        {notes.map((note, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a sent message's notes never change
          <div className="user-note" key={index}>
            <span className="user-note-where">
              {/* A note on a plan has no file behind it, so it reads as prose rather than
                  wearing a path and a colon it cannot live up to. */}
              {note.path === PLAN_PATH ? 'the plan · ' : `${note.path}:`}
              {note.rangeStart < note.line
                ? `${note.path === PLAN_PATH ? 'lines ' : ''}${note.rangeStart}–${note.line}`
                : `${note.path === PLAN_PATH ? 'line ' : ''}${note.line}`}
              {note.side === 'old' && ' (removed line)'}
            </span>
            {note.lineText.trim() !== '' && (
              <code className="user-note-quote">{note.lineText.trim()}</code>
            )}
            <p className="user-note-body">{note.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentProse({ entry }: { entry: Extract<TranscriptEntry, { kind: 'assistant' }> }) {
  return (
    <div className="entry-agent">
      <div className="entry-agent-label">
        <span className="entry-agent-who">agent</span>
        <span className="entry-agent-at">{timeLabel(entry.at)}</span>
      </div>
      <Markdown text={entry.text} />
    </div>
  )
}

/**
 * Reasoning, marked apart from what the agent actually said. Folds to one line once
 * something follows it — watching it think is worth something live and nothing on the way
 * back up. Local override so the reader's own choice always wins over the default.
 */
function Thought({
  entry,
  defaultExpanded,
  duration,
}: {
  entry: Extract<TranscriptEntry, { kind: 'thought' }>
  defaultExpanded: boolean
  duration: string | null
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? defaultExpanded

  if (!expanded) {
    return (
      <button type="button" className="thought-fold-btn" onClick={() => setOverride(true)}>
        ▸ thought{duration !== null && ` for ${duration}`}
      </button>
    )
  }

  return (
    <div className="thought-expanded">
      <button type="button" className="thought-expanded-toggle" onClick={() => setOverride(false)}>
        ▾ thinking
      </button>
      <p className="thought-expanded-text">{entry.text}</p>
    </div>
  )
}

/**
 * A plan that has been decided, in the record of the session it belonged to.
 *
 * Folded by default and titled by its outcome, because that is the part you scan for later —
 * a plan runs to hundreds of lines, and a conversation that opens with all of them buries the
 * turn that followed it. Read-only: the arguing happened on the plan tab, and this is what is
 * left once it was settled.
 */
function PlanRecord({ entry }: { entry: Extract<TranscriptEntry, { kind: 'plan' }> }) {
  const [expanded, setExpanded] = useState(false)
  const outcome = entry.outcome === 'approved' ? 'approved' : 'sent back'
  const label = `plan${entry.round > 1 ? ` · revision ${entry.round}` : ''} — ${outcome}`

  if (!expanded) {
    return (
      <button type="button" className="thought-fold-btn" onClick={() => setExpanded(true)}>
        ▸ {label}
      </button>
    )
  }

  return (
    <div className={`plan-record plan-record-${entry.outcome}`}>
      <button type="button" className="thought-expanded-toggle" onClick={() => setExpanded(false)}>
        ▾ {label}
      </button>
      <div className="plan-record-body">
        <Markdown text={entry.text} />
      </div>
    </div>
  )
}

/** One line of the conversation. */
function EntryView({
  entry,
  thoughtLive,
  thoughtDuration,
  toolsLive,
}: {
  entry: TranscriptEntry | ToolGroupEntry
  /** Only meaningful when `entry.kind === 'thought'`. */
  thoughtLive: boolean
  thoughtDuration: string | null
  /** Only meaningful when `entry.kind === 'tool-group'`. */
  toolsLive: boolean
}) {
  if (entry.kind === 'tool-group') {
    return (
      <ToolGroup group={entry} defaultExpanded={toolsLive} duration={toolGroupDuration(entry)} />
    )
  }
  if (entry.kind === 'tool') return <ToolActivity tool={entry} />
  if (entry.kind === 'subagent') return <SubagentActivity entry={entry} />
  if (entry.kind === 'notice') return <Notice entry={entry} />
  if (entry.kind === 'plan') return <PlanRecord entry={entry} />

  if (entry.kind === 'user') {
    return <UserBubble entry={entry} />
  }

  if (entry.kind === 'thought') {
    return <Thought entry={entry} defaultExpanded={thoughtLive} duration={thoughtDuration} />
  }

  return <AgentProse entry={entry} />
}

/**
 * Only the entry the agent is currently writing into actually changes.
 *
 * `appendEvent` rebuilds the transcript array but keeps every entry object it did not touch, so
 * reference equality is an exact test of "did this line change" for everything but a tool group
 * — those are wrappers `groupForReading` builds fresh each time, and are compared by their
 * contents instead. Without this, a settled transcript of hundreds of entries is reconciled in
 * full on every push during a turn.
 */
const Entry = memo(EntryView, (before, after) => {
  if (
    before.thoughtLive !== after.thoughtLive ||
    before.toolsLive !== after.toolsLive ||
    before.thoughtDuration !== after.thoughtDuration
  ) {
    return false
  }
  const a = before.entry
  const b = after.entry
  if (a === b) return true
  if (a.kind === 'tool-group' && b.kind === 'tool-group') {
    return a.tools.length === b.tools.length && a.tools.every((tool, i) => tool === b.tools[i])
  }
  return false
})

/** The shortest the docked conversation can be dragged: the header and the compose box. */
const MIN_HEIGHT = 140
/** The most of the space it can take, so the file above never disappears under it. */
const MAX_FRACTION = 0.85

/**
 * The conversation, docked along the bottom beneath whatever file is open, and resizable by
 * dragging its top edge.
 *
 * Hideable to a thin bar that still says whether the agent is working and how much is queued,
 * so a reader whose attention is on the file can tell at a glance whether anything needs a
 * second look here. A pending permission question is answered from `PermissionOverlay`
 * instead, so this can stay hidden through one.
 */
export function ConversationPanel({
  state,
  waiting,
  open,
  onOpenChange,
  height,
  onHeightChange,
}: {
  state: SessionState
  waiting: Waiting
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The dock's height, as a fraction of the space it shares with the file pane. */
  height: number
  onHeightChange: (height: number) => void
}) {
  const expanded = open

  // The height while a drag is under way; committed (and remembered) only when it ends, so a
  // drag doesn't write to storage on every pointer move.
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null)

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const el = panel.current
    const container = el?.parentElement
    if (el === null || container === null || container === undefined) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = el.getBoundingClientRect().height
    const space = container.getBoundingClientRect().height
    let latest = startHeight / space
    const move = (moved: PointerEvent): void => {
      const px = Math.max(MIN_HEIGHT, startHeight + startY - moved.clientY)
      latest = Math.min(MAX_FRACTION, px / space)
      setDragHeight(latest)
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setDragHeight(null)
      onHeightChange(latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const [draft, setDraft] = useState('')

  // Nothing closes the box. What you most want to say is usually what you think of halfway into
  // a turn, so while the agent works, whatever you send queues for when the turn ends.
  const busy = state.status === 'working'
  const queueing = busy

  const doing = nowDoing(state.transcript)

  const tail = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  /**
   * Follow the newest line, unless the reader has gone looking at something else.
   *
   * A transcript that always jumped to the bottom would yank the page out from under anyone
   * scrolled up reading what the agent did earlier — which, during a turn that streams for
   * minutes, is most of the time someone spends in this column. So: stick while at the
   * bottom, let go the moment they scroll away, and re-stick when they come back.
   */
  const stuck = useRef(true)

  const onScroll = (): void => {
    const el = column.current
    const end = tail.current
    if (el === null || end === null) return
    stuck.current = end.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom < 24
  }

  // Keyed on the revision rather than the entry count, because streamed prose merges into the
  // entry already there: the column grows without the list getting any longer, and a length
  // trigger would follow tool calls while sitting still through a paragraph.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is the trigger
  useEffect(() => {
    if (expanded && stuck.current) tail.current?.scrollIntoView({ block: 'end' })
  }, [state.revision, expanded])

  // Recomputed only when the transcript itself moves. It walks every entry, and this component
  // re-renders on every pushed state — including, during a turn, one per coalesced batch of
  // streamed tokens — so without this it is O(transcript) work for a change that touches one
  // entry.
  const readingEntries = useMemo(() => groupForReading(state.transcript), [state.transcript])

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Grows the box as the draft grows, up to a cap, and lets it shrink back down again —
  // driven by the draft itself, the same way the scroll-follow effect above is driven by
  // the revision that changes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the trigger
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])

  // A system-composed queued item (`Queued.origin === 'system'`) was never the human's to hold
  // back or send, so it is not listed as theirs.
  const humanQueued = state.queued.filter((message) => message.origin !== 'system')
  // Notes go to the agent only when sent — here, or from the file pane — never riding along
  // with an ordinary prompt.
  const unsentNotes = state.annotations.filter((annotation) => annotation.sentAt === null).length
  const notesLabel = `${unsentNotes} note${unsentNotes === 1 ? '' : 's'}`

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    void post(queueing ? '/queue' : '/prompt', { text })
  }

  const sendNotes = (): void => {
    if (unsentNotes === 0) return
    const text = draft.trim()
    setDraft('')
    void post('/notes/send', { text })
  }

  const status = busy ? 'working' : waiting.on === 'nobody' && waiting.busy ? waiting.label : 'idle'

  if (!expanded) {
    const rail = [status, humanQueued.length > 0 ? `${humanQueued.length} queued` : null]
      .filter((part) => part !== null)
      .join(' · ')
    return (
      <button
        type="button"
        className="bottom-bar"
        title="Show the conversation"
        onClick={() => onOpenChange(true)}
      >
        <span className={`status-dot${busy ? ' live' : ''}`} />
        <span className="bottom-bar-label">conversation</span>
        <span className="bottom-bar-meta">{rail}</span>
        <Chevron dir="up" />
      </button>
    )
  }

  return (
    <aside
      ref={panel}
      className="convo-panel"
      style={{ height: `${(dragHeight ?? height) * 100}%` }}
    >
      <div
        className="convo-resize"
        title="Drag to resize the conversation"
        onPointerDown={startResize}
      />
      <header className="panel-head">
        <span className="lbl">conversation</span>
        <button
          type="button"
          className="panel-hide"
          title="Hide the conversation"
          aria-label="Hide the conversation"
          onClick={() => onOpenChange(false)}
        >
          <Chevron dir="down" />
        </button>
      </header>

      <div className="transcript" ref={column} onScroll={onScroll}>
        <div className="transcript-inner">
          {readingEntries.map(({ entry }, index) => {
            const isLast = index === readingEntries.length - 1
            const thoughtLive = entry.kind === 'thought' && isLast && state.status === 'working'
            const toolsLive = entry.kind === 'tool-group' && isLast && state.status === 'working'
            const next = readingEntries[index + 1]
            const thoughtDuration =
              entry.kind === 'thought' && next !== undefined
                ? formatDuration(
                    new Date(entryAt(next.entry)).getTime() - new Date(entry.at).getTime(),
                  )
                : null
            return (
              // Entries are append-mostly and edit-in-place; position is their identity.
              <Entry
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript order is stable
                key={index}
                entry={entry}
                thoughtLive={thoughtLive}
                thoughtDuration={thoughtDuration}
                toolsLive={toolsLive}
              />
            )
          })}

          {state.status === 'working' && doing.kind === 'thinking' && (
            <div className="entry doing">
              <span className="spinner spinner-inline" aria-hidden="true" />
              <span className="doing-what">thinking…</span>
            </div>
          )}

          <div ref={tail} />
        </div>
      </div>

      {/* What is waiting to go, so queueing is visibly different from sending into a void.
            Withdrawable, because the thought you have mid-turn is often the one you change
            your mind about once you see the rest of what the agent did. */}
      {humanQueued.length > 0 && (
        <div className="queued">
          {humanQueued.map((message) => (
            <div className="queued-item" key={message.id}>
              <div className="queued-head">
                <span className="lbl">queued · sends when the agent stops</span>
                <button
                  type="button"
                  className="note-remove"
                  onClick={() => void post('/queue/remove', { id: message.id })}
                >
                  remove
                </button>
              </div>
              {message.where !== undefined && <span className="queued-where">{message.where}</span>}
              <p className="queued-text">{message.text}</p>
            </div>
          ))}
        </div>
      )}

      <form className="compose" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          className="input compose-textarea"
          value={draft}
          placeholder={
            queueing
              ? 'Say it now — it goes over as soon as the agent stops.'
              : 'What should the agent do?'
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event)
          }}
        />
        <div className="compose-row">
          <button
            type="button"
            className={`btn btn-secondary${state.planMode === 'plan' ? ' active' : ''}`}
            disabled={busy}
            title={
              state.planMode === 'plan'
                ? 'The agent can only read and plan — no file changes until you approve its plan.'
                : 'Restrict the agent to planning: it drafts a plan and you approve it before it can change anything.'
            }
            onClick={() =>
              void post('/plan-mode', {
                mode: state.planMode === 'plan' ? 'default' : 'plan',
              })
            }
          >
            {state.planMode === 'plan' ? 'Plan mode: on' : 'Plan mode'}
          </button>
          <span className="compose-kbd">
            <kbd>⏎</kbd> {queueing ? 'queue' : 'send'}
          </span>
          {busy && (
            <button
              type="button"
              className="btn btn-secondary compose-stop"
              onClick={() => void post('/cancel', {})}
            >
              Stop
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary compose-submit"
            disabled={draft.trim() === ''}
          >
            {queueing ? 'Queue' : 'Send'}
          </button>
        </div>
        {unsentNotes > 0 && (
          <div className="compose-notes">
            <span>{notesLabel} waiting</span>
            <button
              type="button"
              className="btn btn-ghost"
              title="Hands every unsent note to the agent, with whatever you typed after them."
              onClick={sendNotes}
            >
              {draft.trim() === '' ? `Send ${notesLabel}` : 'Send them with this'}
            </button>
          </div>
        )}
      </form>
    </aside>
  )
}
