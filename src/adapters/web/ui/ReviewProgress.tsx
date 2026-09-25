import { useEffect, useState } from 'react'
import { REVIEW_STEPS, type ReviewProgress, type ReviewStep } from '../../../core/types.ts'

const STEP_LABELS: Record<ReviewStep, string> = {
  preparing: 'Preparing the diff',
  starting: 'Starting the reviewer',
  investigating: 'Investigating',
  submitting: 'Submitting findings',
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Re-renders once a second, so the elapsed time moves while nothing else does. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The review in flight, as a strip under the header: which of its four steps it is on, the
 * reviewer's latest call, how many it has made, and how long it has run against its timeout.
 *
 * A review is a whole agent run and routinely takes minutes; a bare spinner cannot tell that
 * apart from a hung one. Shown only while a review runs.
 */
export function ReviewProgressBar({ review }: { review: ReviewProgress }) {
  const now = useNow()
  const index = REVIEW_STEPS.indexOf(review.step)
  const elapsed = now - new Date(review.startedAt).getTime()
  const files = review.files.length
  const detail = review.step === 'investigating' ? review.current : null

  return (
    <div className="review-progress" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="review-progress-title">
        Reviewing {files} {files === 1 ? 'file' : 'files'}
      </span>
      <ol
        className="review-progress-steps"
        aria-label={`Step ${index + 1} of ${REVIEW_STEPS.length}`}
      >
        {REVIEW_STEPS.map((step, i) => (
          <li
            key={step}
            className={`review-progress-segment${i < index ? ' done' : i === index ? ' current' : ''}`}
            title={`${i + 1}. ${STEP_LABELS[step]}`}
          />
        ))}
      </ol>
      <span className="review-progress-step">
        {index + 1}/{REVIEW_STEPS.length} · {STEP_LABELS[review.step]}
      </span>
      {detail !== null && (
        <span className="review-progress-detail" title={detail}>
          {detail}
        </span>
      )}
      <span className="review-progress-meta">
        {review.toolCalls > 0 && (
          <span>
            {review.toolCalls} {review.toolCalls === 1 ? 'call' : 'calls'}
          </span>
        )}
        <span title={`Gives up after ${clock(review.timeoutMs)}`}>
          {clock(elapsed)} / {clock(review.timeoutMs)}
        </span>
      </span>
    </div>
  )
}
