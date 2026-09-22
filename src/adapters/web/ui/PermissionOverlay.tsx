import { useEffect } from 'react'
import type { PendingPermission } from '../../../core/types.ts'
import { post } from './http.ts'

/** The two "*_always" kinds grant or deny a standing permission rather than answering just
 *  this one request — worth marking on its own so a reader scanning for "allow" doesn't reach
 *  for a broad grant by mistake. */
function isStanding(kind: string): boolean {
  return kind.endsWith('_always')
}

/** `allow_once` is the one safe, expected answer and gets the same weight `Decide`'s Approve
 *  does. A standing grant gets a cautionary border even when it's an allow, and any reject
 *  gets the same red `Decide` already uses for "Send back". */
function optionClassName(kind: string): string {
  if (kind === 'allow_once') return 'btn btn-primary'
  if (kind.startsWith('allow')) return 'btn btn-secondary permission-standing'
  return 'btn btn-secondary permission-reject'
}

/**
 * The generic ACP permission prompt, as a blocking overlay over the whole app.
 *
 * Mounted once at `App`'s root rather than inside the conversation drawer: the agent is
 * genuinely stopped until this is answered, a heavier claim than anything else the drawer
 * makes, and there is nothing here to show but the question and the offered answers — no diff,
 * no risk check, so it doesn't borrow `ChunkView`'s `Decide` machinery either.
 *
 * One at a time. `session.ts` appends every pending request to the same array in arrival order
 * and only drops one once it's answered, so the oldest is always first; anything behind it is
 * named by count rather than shown, since two competing questions on screen at once would just
 * be two overlays fighting for attention.
 */
export function PermissionOverlay({ permissions }: { permissions: PendingPermission[] }) {
  const current = permissions[0] ?? null
  const waitingBehind = permissions.length - 1

  // Numbered rather than reusing `Decide`'s fixed A/R keys: there's no stable meaning to hang
  // a single letter on when the agent can offer anywhere from two to four options.
  useEffect(() => {
    if (current === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
      ) {
        return
      }
      const option = current.options[Number(event.key) - 1]
      if (option !== undefined)
        void post('/permission', { id: current.id, optionId: option.optionId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])

  if (current === null) return null

  return (
    <div className="permission-overlay" role="alertdialog" aria-modal="true">
      <div className="permission-card">
        <p className="challenge-kicker">Agent is asking</p>
        <h2 className="permission-title">{current.title}</h2>

        {/* The command itself, verbatim: approving something you cannot see is the whole
            failure this replaced. */}
        {current.subject !== null && <pre className="permission-subject">{current.subject}</pre>}

        {current.description !== null && (
          <p className="permission-description">{current.description}</p>
        )}

        {current.reason !== null && <p className="permission-reason">{current.reason}</p>}

        <div className="permission-options">
          {current.options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              className={optionClassName(option.kind)}
              onClick={() =>
                void post('/permission', { id: current.id, optionId: option.optionId })
              }
            >
              <span className="permission-option-label">
                {option.name}
                {isStanding(option.kind) && <span className="permission-badge">always</span>}
              </span>
              {index < 9 && <kbd>{index + 1}</kbd>}
            </button>
          ))}
        </div>

        {waitingBehind > 0 && (
          <p className="decide-note permission-queue-note">
            {waitingBehind} more {waitingBehind === 1 ? 'question' : 'questions'} waiting
          </p>
        )}
      </div>
    </div>
  )
}
