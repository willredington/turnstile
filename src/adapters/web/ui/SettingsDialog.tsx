import { useEffect } from 'react'

/**
 * Settings, opened from the top bar. Each section says where it stands and opens its own
 * screen; the settings themselves are edited there, not here.
 */
export function SettingsDialog({
  autoMode,
  onEditAutoMode,
  onClose,
}: {
  /** Whether tool permissions are set up; null when the server offers none. */
  autoMode: 'on' | 'off' | null
  /** Opens the tool-permissions setup screen in place of this one. */
  onEditAutoMode: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="permission-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="permission-card settings-card">
        <h2 className="permission-title">Settings</h2>

        <section className="settings-section">
          <div className="settings-section-text">
            <h3 className="settings-section-title">Tool permissions</h3>
            <p className="settings-section-status">
              {autoMode === 'on'
                ? 'Set up. Calls that match your statements ask you first; the rest run.'
                : autoMode === 'off'
                  ? 'Not set up, so every tool call asks you.'
                  : 'Unavailable.'}
            </p>
          </div>
          {autoMode !== null && (
            <button
              type="button"
              className={`btn btn-secondary${autoMode === 'off' ? ' top-bar-auto-mode-off' : ''}`}
              onClick={onEditAutoMode}
            >
              {autoMode === 'on' ? 'Edit' : 'Set up'}
            </button>
          )}
        </section>

        <div className="settings-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
