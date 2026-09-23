import { useEffect, useState } from 'react'
import {
  type AutoModePolicy,
  type AutoModeSettings,
  type AutoModeTrial,
  DEFAULT_THRESHOLD,
  SENSITIVITIES,
} from '../../../core/autoMode.ts'
import { postForJson } from './http.ts'

/** A statement as it stands on screen: kept or not, and possibly reworded. */
type Draft = { id: string; text: string; enabled: boolean; seed: boolean }

/**
 * What the screen opens with. Before any policy: the suggestions, with the recommended ones
 * ticked, and any old deny patterns ticked for rewording. After: the saved statements, then
 * whichever suggestions were left out, unticked, so they can be taken back up.
 */
function draftsFrom(settings: AutoModeSettings): Draft[] {
  const seedIds = new Set(settings.seeds.map((seed) => seed.id))
  if (settings.policy === null) {
    return [
      ...settings.seeds.map((seed) => ({ ...seed, enabled: seed.suggested, seed: true })),
      ...settings.migrated.map((rule) => ({ ...rule, enabled: true, seed: false })),
    ]
  }
  const saved = new Set(settings.policy.rules.map((rule) => rule.id))
  return [
    ...settings.policy.rules.map((rule) => ({
      ...rule,
      enabled: true,
      seed: seedIds.has(rule.id),
    })),
    ...settings.seeds
      .filter((seed) => !saved.has(seed.id))
      .map((seed) => ({ ...seed, enabled: false, seed: true })),
  ]
}

function policyFrom(drafts: Draft[], threshold: number): AutoModePolicy {
  return {
    version: 1,
    threshold,
    rules: drafts
      .filter((draft) => draft.enabled && draft.text.trim() !== '')
      .map(({ id, text }) => ({ id, text: text.trim() })),
  }
}

/** What each sensitivity does, in words, since the threshold behind it means nothing to a reader. */
const SENSITIVITY_HINTS: Record<(typeof SENSITIVITIES)[number]['id'], string> = {
  strict: 'Asks at the faintest resemblance to a statement',
  balanced: 'Asks when a call plausibly matches a statement',
  relaxed: 'Asks only when a call clearly matches a statement',
}

/**
 * Auto-mode's one-time setup, and where it is changed later.
 *
 * The reader says, in their own words, when a tool call should be put to them; every other call
 * runs without asking. Each statement is judged separately against every call, so the list reads
 * as "ask me if it does any of these". The "Try a command" box judges a command against the
 * statements as they stand on screen, saved or not, which is the only honest way to find out
 * whether a statement means to the judge what it means to the person who wrote it.
 */
export function AutoModeSetup({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (settings: AutoModeSettings) => void
}) {
  const [settings, setSettings] = useState<AutoModeSettings | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [adding, setAdding] = useState('')
  const [command, setCommand] = useState('')
  const [trial, setTrial] = useState<AutoModeTrial | null>(null)
  const [trying, setTrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    void fetch('/auto-mode')
      .then((response) => response.json())
      .then((next: AutoModeSettings) => {
        if (!live) return
        setSettings(next)
        setDrafts(draftsFrom(next))
        setThreshold(next.policy?.threshold ?? DEFAULT_THRESHOLD)
      })
      .catch(() => {
        if (live) setError('Could not load auto-mode settings.')
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const change = (id: string, patch: Partial<Draft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    )
    setTrial(null)
  }

  const add = (): void => {
    const text = adding.trim()
    if (text === '') return
    setDrafts((current) => [
      ...current,
      { id: `custom-${Date.now().toString(36)}`, text, enabled: true, seed: false },
    ])
    setAdding('')
    setTrial(null)
  }

  const tryIt = async (): Promise<void> => {
    if (command.trim() === '') return
    setTrying(true)
    setError(null)
    try {
      setTrial(
        await postForJson<AutoModeTrial>('/auto-mode/trial', {
          command,
          policy: policyFrom(drafts, threshold),
        }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTrying(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/auto-mode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(policyFrom(drafts, threshold)),
      })
      const body = (await response.json().catch(() => null)) as
        | (AutoModeSettings & { error?: string })
        | null
      if (!response.ok || body === null) throw new Error(body?.error ?? 'Saving failed.')
      onSaved(body)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const probabilityOf = (id: string): number | null =>
    trial?.probabilities.find((entry) => entry.id === id)?.probability ?? null
  const startOver = (): void => {
    if (settings === null) return
    setDrafts(draftsFrom({ ...settings, policy: null }))
    setThreshold(DEFAULT_THRESHOLD)
    setTrial(null)
  }
  const kept = drafts.filter((draft) => draft.enabled && draft.text.trim() !== '').length

  return (
    <div className="permission-overlay" role="dialog" aria-modal="true" aria-label="Auto-mode">
      <div className="permission-card auto-mode-card">
        <p className="challenge-kicker">Auto-mode</p>
        <h2 className="permission-title">When should the agent ask you first?</h2>
        <p className="permission-description">
          Every tool call is checked against these statements. If it looks like any of them, you're
          asked. Otherwise it runs. If the check can't run, you're asked.
        </p>

        {settings === null && error === null && <p className="permission-reason">Loading…</p>}

        {settings !== null && (
          <>
            <ul className="auto-mode-rules">
              {drafts.map((draft) => {
                const probability = draft.enabled ? probabilityOf(draft.id) : null
                const fired = probability !== null && probability >= threshold
                return (
                  <li
                    key={draft.id}
                    className={`auto-mode-rule${draft.enabled ? '' : ' auto-mode-rule-off'}`}
                  >
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      aria-label={`Ask when it: ${draft.text}`}
                      onChange={(event) => change(draft.id, { enabled: event.target.checked })}
                    />
                    <input
                      type="text"
                      className="auto-mode-rule-text"
                      value={draft.text}
                      onChange={(event) => change(draft.id, { text: event.target.value })}
                    />
                    {probability !== null && (
                      <span
                        className={`auto-mode-score${fired ? ' auto-mode-score-fired' : ''}`}
                        title={
                          fired
                            ? 'The command looks like this, so you would be asked'
                            : 'The command does not look like this'
                        }
                      >
                        {fired ? 'Asks' : 'Passes'}
                      </span>
                    )}
                    {!draft.seed && (
                      <button
                        type="button"
                        className="btn btn-secondary auto-mode-remove"
                        aria-label="Remove statement"
                        onClick={() =>
                          setDrafts((current) => current.filter((other) => other.id !== draft.id))
                        }
                      >
                        ×
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>

            <form
              className="auto-mode-add"
              onSubmit={(event) => {
                event.preventDefault()
                add()
              }}
            >
              <input
                type="text"
                placeholder="Also ask when it… e.g. “Touches anything under infra/”"
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
              />
              <button type="submit" className="btn btn-secondary" disabled={adding.trim() === ''}>
                Add
              </button>
            </form>

            <fieldset className="auto-mode-sensitivity">
              <legend>Sensitivity</legend>
              {SENSITIVITIES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={`btn ${threshold === choice.threshold ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setThreshold(choice.threshold)}
                  title={SENSITIVITY_HINTS[choice.id]}
                >
                  {choice.label}
                </button>
              ))}
            </fieldset>

            <form
              className="auto-mode-add"
              onSubmit={(event) => {
                event.preventDefault()
                void tryIt()
              }}
            >
              <input
                type="text"
                className="auto-mode-try"
                placeholder="Try a command, e.g. git push --force"
                value={command}
                onChange={(event) => {
                  setCommand(event.target.value)
                  setTrial(null)
                }}
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={trying || command.trim() === ''}
              >
                {trying ? 'Checking…' : 'Try'}
              </button>
            </form>
            {trial !== null && (
              <p className="permission-reason auto-mode-verdict">
                {trial.verdict.kind === 'allow' && 'Passes: would run without asking.'}
                {trial.verdict.kind === 'flag' && 'Asks: would ask you first.'}
                {trial.verdict.kind === 'unavailable' &&
                  `Couldn't check (${trial.verdict.reason}). Until it can, every call asks you.`}
              </p>
            )}
          </>
        )}

        {error !== null && <p className="permission-reason auto-mode-error">{error}</p>}

        <div className="auto-mode-actions">
          {settings?.policy != null && (
            <button
              type="button"
              className="btn btn-secondary auto-mode-start-over"
              title="Back to the suggested statements and Balanced, as on first setup. Nothing changes until you save."
              onClick={startOver}
            >
              Start over
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {settings?.policy === null ? 'Later' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={settings === null || saving}
            onClick={() => void save()}
          >
            {saving
              ? 'Saving…'
              : kept === 0
                ? 'Save — never ask'
                : `Save ${kept} ${kept === 1 ? 'statement' : 'statements'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
