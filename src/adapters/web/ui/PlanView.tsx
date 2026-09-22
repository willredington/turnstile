import { useEffect, useRef, useState } from 'react'
import type { PlanReviewState } from '../../../core/types.ts'
import { PlanDocument } from './PlanDocument.tsx'

/**
 * A plan the agent has submitted, read the way a changed file is read: the whole document, line
 * numbers you can drag, notes anchored to the lines they are about.
 *
 * It used to be a modal — a wall of rendered markdown and a yes/no. That is the shape of prompt
 * that trains a reader to click through it, which is the drift this whole tool exists to fight,
 * and it was the one document in the app you could not actually mark up.
 *
 * The one thing it keeps from the modal is that it blocks. Every other surface here is
 * non-committal: you read a file, you leave notes, you send them when you choose, and nothing
 * waits on you. A plan does wait, so this pane has a decision on it and its tab cannot be
 * closed — but you can still walk away to read the code the plan is about, which is usually the
 * only way to know whether the plan is any good.
 */
export function PlanView({
  planReview,
  onApprove,
  onSendBack,
  onAnnotate,
  onRemoveNote,
}: {
  planReview: PlanReviewState
  onApprove: () => void
  onSendBack: (feedback: string) => void
  onAnnotate: (rangeStart: number, line: number, lineText: string, body: string) => void
  onRemoveNote: (id: string) => void
}) {
  const [sendingBack, setSendingBack] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  const { plan, round, notes } = planReview

  // A new round is a different plan: the box closes and whatever was typed for the last one goes
  // with it, rather than being sent back against text it was never about.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the round is the trigger
  useEffect(() => {
    setSendingBack(false)
    setFeedback('')
  }, [round])

  useEffect(() => {
    if (sendingBack) feedbackRef.current?.focus()
  }, [sendingBack])

  // Notes are a reason in themselves, so the message is only required without them.
  const canSendBack = notes.length > 0 || feedback.trim() !== ''
  const send = (): void => {
    if (!canSendBack) return
    onSendBack(feedback.trim())
  }

  const lines = plan === '' ? 0 : plan.replace(/\n$/, '').split('\n').length
  const facts = [
    planReview.recovered ? 'carried over from earlier in this session' : null,
    round > 1 ? `revision ${round}` : null,
    `${lines} ${lines === 1 ? 'line' : 'lines'}`,
    notes.length > 0 ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : null,
  ].filter((fact) => fact !== null)

  return (
    <div className="file-pane">
      <header className="file-pane-head">
        <div className="file-pane-title">
          <h2>
            {/* A no-break space: the title is a flex row, which would drop an ordinary one. */}
            <span className="file-pane-dir">{'the agent’s\u00a0'}</span>
            <span className="file-pane-name">plan</span>
          </h2>
          <span className="file-pane-facts">{facts.join(' · ')}</span>
        </div>
        <div className="file-pane-actions">
          <button
            type="button"
            className="btn btn-secondary reject"
            onClick={() => setSendingBack(true)}
            disabled={sendingBack}
          >
            Send back…
          </button>
          <button
            type="button"
            className="btn btn-primary approve"
            // A note is a disagreement. Approving over one would drop it with the round and
            // tell the agent the plan was fine — so the way out is to send it back, or to
            // withdraw the note if you have changed your mind.
            disabled={notes.length > 0}
            title={
              notes.length > 0
                ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} on this plan — send it back, or remove them first.`
                : planReview.recovered
                  ? 'The agent is told the plan stands, leaves plan mode, and carries it out.'
                  : 'The agent leaves plan mode and starts work.'
            }
            onClick={onApprove}
          >
            Approve plan
          </button>
        </div>
      </header>

      {sendingBack && (
        <div className="reject-box">
          <div className="reject-box-head">
            <span className="reject-box-kicker">sending back</span>
            <span className="reject-box-target">
              {notes.length === 0
                ? 'becomes the agent’s next instruction'
                : `goes with ${notes.length === 1 ? 'the note' : `all ${notes.length} notes`}`}
            </span>
            <button
              type="button"
              className="reject-box-cancel"
              onClick={() => {
                setSendingBack(false)
                setFeedback('')
              }}
            >
              Cancel <kbd>esc</kbd>
            </button>
          </div>
          <textarea
            ref={feedbackRef}
            className="input reject-box-field"
            placeholder={
              notes.length === 0
                ? 'What needs to change about the plan? The agent revises it and submits it again.'
                : 'Anything to add to the notes? Optional — they go back either way.'
            }
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSendingBack(false)
                setFeedback('')
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
            }}
          />
          <div className="reject-box-foot">
            <span className="reject-box-hint">
              {canSendBack
                ? 'The agent stays in plan mode and submits a new plan.'
                : 'Leave a note on the lines you disagree with, or say what is wrong here.'}
            </span>
            <button
              type="button"
              className="btn btn-secondary reject"
              disabled={!canSendBack}
              onClick={send}
            >
              Send back <kbd>⌘⏎</kbd>
            </button>
          </div>
        </div>
      )}

      <div className="file-pane-body plan-pane-body">
        <PlanDocument
          plan={plan}
          notes={notes}
          onAnnotate={onAnnotate}
          onRemoveNote={onRemoveNote}
        />
      </div>

      <footer className="file-pane-foot">
        <span>Highlight anything you disagree with, or drag the margin beside it.</span>
        <span className="file-pane-foot-end">
          {planReview.recovered
            ? 'Still the plan on the table — nobody accepted it, and nothing has replaced it. Your decision goes to the agent as its next instruction.'
            : 'The agent is waiting on this.'}
        </span>
      </footer>
    </div>
  )
}
