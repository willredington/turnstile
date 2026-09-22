import { useState } from 'react'
import type { AgentQuestion, PendingQuestion } from '../../../core/types.ts'
import { post } from './http.ts'

/** One question's in-progress answer, held locally until every question in the set is
 *  answered and the whole batch is sent at once — the SDK expects one `answers` object
 *  covering every question `AskUserQuestion` asked, not an answer per question. */
type Draft = { selected: Set<string>; useOther: boolean; otherText: string }

function emptyDraft(): Draft {
  return { selected: new Set(), useOther: false, otherText: '' }
}

/** Single-select replaces the selection outright; multi-select toggles membership. */
function withOptionSelected(draft: Draft, label: string, multiSelect: boolean): Draft {
  if (!multiSelect) return { ...draft, selected: new Set([label]), useOther: false }
  const selected = new Set(draft.selected)
  if (selected.has(label)) selected.delete(label)
  else selected.add(label)
  return { ...draft, selected, useOther: false }
}

function isAnswered(draft: Draft): boolean {
  return draft.useOther ? draft.otherText.trim() !== '' : draft.selected.size > 0
}

/** What `session.answerQuestion` — and the SDK underneath it — expects for one question: the
 *  selected label for a single-select question, the selected labels for a multi-select one,
 *  or whatever free text the user typed in place of Claude's own options. */
function answerValue(draft: Draft, multiSelect: boolean): string | string[] {
  if (draft.useOther) return draft.otherText.trim()
  const labels = [...draft.selected]
  return multiSelect ? labels : (labels[0] ?? '')
}

/**
 * One pending `AskUserQuestion` call, rendered and answered as a unit.
 *
 * Mounted with `key={pending.id}` by the overlay below, so a fresh question set — even one
 * that happens to reuse earlier question text — always starts with its own untouched `drafts`
 * state rather than needing an effect to reset it by hand.
 */
function QuestionCard({
  pending,
  waitingBehind,
}: {
  pending: PendingQuestion
  waitingBehind: number
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const draftFor = (question: AgentQuestion): Draft => drafts[question.question] ?? emptyDraft()
  const setDraftFor = (question: AgentQuestion, next: Draft): void =>
    setDrafts((prev) => ({ ...prev, [question.question]: next }))

  const ready = pending.questions.every((q) => isAnswered(draftFor(q)))

  const submit = (): void => {
    if (!ready) return
    const answers: Record<string, string | string[]> = {}
    for (const q of pending.questions) {
      answers[q.question] = answerValue(draftFor(q), q.multiSelect)
    }
    void post('/question', { id: pending.id, answers })
  }

  return (
    <div className="permission-card question-card">
      <p className="challenge-kicker">Agent is asking</p>

      <div className="question-list">
        {pending.questions.map((q) => {
          const draft = draftFor(q)
          return (
            <div className="question-block" key={q.question}>
              {q.header !== '' && <p className="question-header">{q.header}</p>}
              <h2 className="permission-title question-title">{q.question}</h2>

              <div className="question-options">
                {q.options.map((option) => {
                  const selected = !draft.useOther && draft.selected.has(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={
                        selected
                          ? 'btn btn-secondary active question-option'
                          : 'btn btn-secondary question-option'
                      }
                      aria-pressed={selected}
                      onClick={() =>
                        setDraftFor(q, withOptionSelected(draft, option.label, q.multiSelect))
                      }
                    >
                      <span className="question-option-label">{option.label}</span>
                      {option.description !== '' && (
                        <span className="question-option-description">{option.description}</span>
                      )}
                    </button>
                  )
                })}

                <label
                  className={
                    draft.useOther
                      ? 'question-option question-option-other active'
                      : 'question-option question-option-other'
                  }
                >
                  <span className="question-option-label">Something else</span>
                  <input
                    className="input"
                    type="text"
                    value={draft.otherText}
                    placeholder="Type your own answer…"
                    onFocus={() => setDraftFor(q, { ...draft, useOther: true })}
                    onChange={(event) =>
                      setDraftFor(q, { ...draft, useOther: true, otherText: event.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>

      <div className="question-actions">
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={submit}>
          Send answers
        </button>
      </div>

      {waitingBehind > 0 && (
        <p className="decide-note permission-queue-note">
          {waitingBehind} more {waitingBehind === 1 ? 'question' : 'questions'} waiting
        </p>
      )}
    </div>
  )
}

/**
 * The `AskUserQuestion` prompt: Claude blocked mid-task on one or more multiple-choice
 * questions it generated itself (see the Agent SDK's "handle clarifying questions" guide).
 *
 * Kept separate from `PermissionOverlay` rather than folded into its flat options list: the
 * shape is fundamentally different (1-4 questions, each with its own options and an optional
 * multi-select), and every question in one `AskUserQuestion` call has to be answered together
 * in a single `answers` object — there is no per-question submit. Mounted the same way
 * `PermissionOverlay` is: a blocking overlay over the whole app, since the agent really is
 * stopped until this is answered.
 */
export function QuestionOverlay({ questions }: { questions: PendingQuestion[] }) {
  const current = questions[0] ?? null
  if (current === null) return null

  return (
    <div className="permission-overlay question-overlay" role="alertdialog" aria-modal="true">
      <QuestionCard key={current.id} pending={current} waitingBehind={questions.length - 1} />
    </div>
  )
}
