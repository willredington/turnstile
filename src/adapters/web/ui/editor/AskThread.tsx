import { useState } from 'react'
import { anchorLabel } from '../../../../core/ask.ts'
import { Markdown } from '../Markdown.tsx'
import type { AskThread as Thread } from './askMemory.ts'
import { useTakesTheCursor } from './parts.tsx'

/**
 * One thread of questions about a file, as a card set into the document.
 *
 * Built to read as the same family of card as a note, because it is the same gesture: you
 * picked some lines and said something about them. The difference is what happens next, and
 * the card says which — a note is addressed to the agent and waits to be sent, this is
 * addressed to nobody and is already answered.
 *
 * Presentational, like everything else in this folder: it is handed a thread and callbacks, and
 * knows nothing about how it got on screen or where the answer came from.
 */
export function AskThread({
  thread,
  onFollow,
  onClose,
}: {
  thread: Thread
  onFollow: (question: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  // A card opened by the header button appears with nothing in it, so it takes the cursor.
  const box = useTakesTheCursor<HTMLTextAreaElement>(
    thread.turns.length === 0 && thread.pending === null,
  )
  const pending = thread.pending
  const waiting = pending !== null && thread.error === null

  const submit = (): void => {
    const question = draft.trim()
    if (question === '') return
    setDraft('')
    onFollow(question)
  }

  return (
    <div className="ask">
      <div className="note-head">
        <span className="note-who">
          <span className="note-dot" />
          your question
        </span>
        <span className="note-where">{anchorLabel(thread.anchor)}</span>
        <button type="button" className="ask-close" onClick={onClose}>
          Close
        </button>
      </div>

      {thread.turns.map((turn) => (
        <div className="ask-turn" key={turn.question}>
          <p className="ask-question">{turn.question}</p>
          <div className="ask-answer">
            <Markdown text={turn.answer} />
          </div>
        </div>
      ))}

      {pending !== null && (
        <div className="ask-turn">
          <p className="ask-question">{pending}</p>
          {/* Several seconds of silence reads as broken, so the wait is shown rather than left
              to be inferred from nothing happening. */}
          {waiting ? (
            <p className="ask-waiting">
              <span className="spinner spinner-inline" aria-hidden="true" />
              Reading the code…
            </p>
          ) : (
            <p className="ask-error">
              {thread.error}
              <button type="button" className="ask-retry" onClick={() => onFollow(pending)}>
                Try again
              </button>
            </p>
          )}
        </div>
      )}

      {!waiting && (
        <div className="ask-reply">
          <textarea
            ref={box}
            value={draft}
            rows={1}
            placeholder={
              thread.turns.length > 0
                ? 'Ask a follow-up…'
                : thread.anchor === null
                  ? 'Ask about this file…'
                  : 'Ask about these lines…'
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft('')
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={draft.trim() === ''}
            onClick={submit}
          >
            Ask
          </button>
        </div>
      )}
    </div>
  )
}
