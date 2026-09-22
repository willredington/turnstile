import { useEffect, useRef, useState } from 'react'
import type { Activity } from '../../../core/activity.ts'
import type { DiffView, SessionSummary } from '../../../core/types.ts'
import { post } from './http.ts'
import { TurnstileMark } from './TurnstileMark.tsx'

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * New session / resume a past one, from anywhere in the app.
 *
 * Sessions are fetched lazily, on open — same reasoning as `/files`: most of a session's state
 * changes have nothing to do with what else is out there to resume.
 */
function SessionSwitcher({
  currentSessionId,
  disabled,
  disabledReason,
}: {
  currentSessionId: string
  disabled: boolean
  disabledReason: string
}) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    void fetch('/sessions')
      .then((response) => response.json())
      .then((next: SessionSummary[]) => {
        if (live) setSessions(next)
      })
      .catch(() => {
        if (live) setSessions([])
      })
    return () => {
      live = false
    }
  }, [open])

  // Closes on an outside click, the ordinary way any menu does.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const others = (sessions ?? []).filter((s) => s.sessionId !== currentSessionId)
  const last = others[0] ?? null

  const switchTo = async (proceed: () => Promise<void>): Promise<void> => {
    setOpen(false)
    await proceed()
  }

  const startNew = (): void => {
    void switchTo(() => post('/session/new', {}))
  }

  const resume = (sessionId: string): void => {
    void switchTo(() => post('/session/resume', { sessionId }))
  }

  return (
    <div className="session-switcher" ref={rootRef}>
      <button
        type="button"
        className="btn btn-secondary session-switcher-trigger"
        disabled={disabled}
        title={disabled ? disabledReason : 'Start a new session or resume a past one'}
        onClick={() => setOpen((was) => !was)}
      >
        Sessions
      </button>

      {open && (
        <div className="session-switcher-menu">
          <button type="button" className="session-switcher-item" onClick={startNew}>
            New session
          </button>

          {last !== null && (
            <button
              type="button"
              className="session-switcher-item"
              onClick={() => resume(last.sessionId)}
            >
              Resume last{last.title !== null ? ` — ${last.title}` : ''}
            </button>
          )}

          <div className="session-switcher-label">Browse sessions</div>
          {sessions === null && <div className="session-switcher-empty">Loading…</div>}
          {sessions !== null && others.length === 0 && (
            <div className="session-switcher-empty">No past sessions yet.</div>
          )}
          {others.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              className="session-switcher-item"
              onClick={() => resume(s.sessionId)}
            >
              <span>{s.title ?? s.sessionId.slice(0, 8)}</span>
              {s.updatedAt !== null && (
                <span className="session-switcher-time">{timeLabel(s.updatedAt)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What the agent is doing, as one line centered in the header — see `core/activity.ts`.
 * Informational only: nothing here is clickable.
 */
function ActivityBar({ activity }: { activity: Activity }) {
  const spins = activity.tone === 'live' || activity.tone === 'starting'
  return (
    <div className={`activity-bar activity-${activity.tone}`} role="status">
      <span className="activity-mark" aria-hidden="true">
        {spins ? <span className="spinner" /> : <span className="activity-dot" />}
      </span>
      <span className="activity-verb">{activity.verb}</span>
      {activity.target !== '' && (
        <span className="activity-target" title={activity.target}>
          {activity.target}
        </span>
      )}
    </div>
  )
}

/**
 * The app's header: where the session stands (project, branch, delta against the session's
 * baseline), what the agent is doing right now (the activity bar, centered), what it is running
 * (model, context), and the session switcher.
 *
 * A three-column grid, so the activity bar stays optically centered however long the path and
 * branch run.
 */
export function TopBar({
  activity,
  diff,
  sessionId,
  switchDisabled,
  switchDisabledReason,
  cwd,
  model,
  thinkingLevel,
  contextUsed,
  contextSize,
}: {
  activity: Activity
  diff: DiffView | null
  sessionId: string
  /** Whether a turn is running — the session switch would be refused. */
  switchDisabled: boolean
  switchDisabledReason: string
  /** The project root, abbreviated under the home directory (`~/...`) by the server. */
  cwd: string
  /** The coding agent's currently selected model, or null before it has reported one. */
  model: string | null
  /** The agent's reasoning/thinking effort level, or null before it has reported one. */
  thinkingLevel: string | null
  /** Tokens currently in the agent's context window, or null before any usage is known. */
  contextUsed: number | null
  /** The agent's total context window size in tokens. */
  contextSize: number | null
}) {
  const added = diff?.files.reduce((sum, file) => sum + file.patch.addedCount, 0) ?? 0
  const removed = diff?.files.reduce((sum, file) => sum + file.patch.removedCount, 0) ?? 0
  const contextPercent =
    contextUsed !== null && contextSize !== null && contextSize > 0
      ? Math.round((100 * contextUsed) / contextSize)
      : null

  const branch = diff?.branch ?? null
  const agentLabel = [model, thinkingLevel, contextPercent === null ? null : `${contextPercent}%`]
    .filter((value) => value !== null)
    .join(' · ')

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <div className="top-bar-brand">
          <TurnstileMark size={18} />
          <span className="brand">Turnstile</span>
        </div>
        <span className="top-bar-divider" aria-hidden="true" />

        {cwd !== '' && <span className="top-bar-where">{cwd}</span>}
        {cwd !== '' && branch !== null && <span className="top-bar-dot">·</span>}
        {branch !== null && <span className="top-bar-where">{branch}</span>}
        {(added > 0 || removed > 0) && (
          <span className="top-bar-delta">
            <span className="added">+{added}</span> <span className="removed">−{removed}</span>
          </span>
        )}
      </div>

      <div className="top-bar-center">
        {/* Keyed, so each new thing the agent does fades in rather than swapping in place. */}
        <ActivityBar key={`${activity.verb}\u0000${activity.target}`} activity={activity} />
      </div>

      <div className="top-bar-right">
        {agentLabel !== '' && (
          <div className="top-bar-agent">
            <span>{agentLabel}</span>
            {contextPercent !== null && (
              <span
                className="top-bar-meter"
                title={`${contextPercent}% of the context window used`}
              >
                <span style={{ width: `${Math.min(100, contextPercent)}%` }} />
              </span>
            )}
          </div>
        )}
        <SessionSwitcher
          currentSessionId={sessionId}
          disabled={switchDisabled}
          disabledReason={switchDisabledReason}
        />
      </div>
    </header>
  )
}
