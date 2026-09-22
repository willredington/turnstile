import { useState } from 'react'

/**
 * Shown instead of the workspace when the project cannot be tracked: Turnstile records where
 * each session started in git, so a directory with no repository has nowhere to put it.
 */
export function UntrackedPanel({ cwd }: { cwd: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const initialize = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const response = await fetch('/repo/init', { method: 'POST' }).catch(() => null)
    if (response === null) {
      setError('could not reach Turnstile')
    } else if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { error?: string }
      setError(failure.error ?? 'initialization failed')
    }
    setBusy(false)
  }

  return (
    <div className="untracked">
      <div className="placeholder untracked-card">
        <h2>This directory isn't tracked — Turnstile needs git</h2>
        <p>
          Turnstile measures each session's changes from where it started, recorded in git, so it
          can't open a session in {cwd === '' ? 'this directory' : cwd} until it is a git
          repository.
        </p>
        <p>
          Initializing commits everything already here as the first commit, leaving out build output
          (<code>target/</code>, <code>node_modules/</code> and the like).
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void initialize()}
        >
          {busy ? 'Initializing…' : 'Initialize git and commit current files'}
        </button>
        {error !== null && <p className="untracked-error">{error}</p>}
      </div>
    </div>
  )
}
