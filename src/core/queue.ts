/**
 * What the human wrote while the agent was busy.
 *
 * A turn is minutes long, and the thing you most want to say is usually the thing you think
 * of halfway through it — watching a change land and realising it is going the wrong way. The
 * box was closed for the whole of that, so the choice was to hold the thought or lose it.
 *
 * So it queues instead. The messages are not sent one at a time as they are written, because
 * interrupting an agent mid-turn is how you get half-finished work; they are batched and
 * handed over at the next moment the agent is being spoken to anyway — which is either the
 * rejection that sends this turn back, or the turn that follows it. Riding the rejection is
 * the case worth having: the alternative spends a whole extra round saying separately what
 * could have been said in the same breath.
 *
 * Deliberately not the annotation queue. A note is anchored to a line and goes stale when
 * that line is rewritten; a message is about the work, and staleness is not a thing that can
 * happen to it.
 */

export type Queued = {
  id: string
  text: string
  at: string
  /**
   * The lines this is about, when it is about lines — `src/orders.ts:9-18`.
   *
   * A message sent back about one change has to say which; without it the agent is told what
   * is wrong and left to guess where, which is the content-hash problem in a new costume.
   */
  where?: string
  /**
   * Absent (or `'human'`) is what this file is named for — something typed while the agent
   * was busy. `'system'` is text Turnstile composed for the agent's own eyes: real, and still
   * owed to the agent, but never something the human said, and never to be shown back to them
   * as if it were. Nothing sets `'system'` today — the one caller that did, a per-edit
   * rejection's own reasoning, was retired once `propose_edit` made the queued follow-up it
   * existed for unnecessary (see `Session.writeFile` in `app/session.ts`) — but the
   * distinction costs nothing to keep for whatever needs it next.
   */
  origin?: 'human' | 'system'
}

/** Add a message. Blank text queues nothing — an empty send is not a message. */
export function enqueue(
  queue: Queued[],
  text: string,
  id: string,
  at: string,
  where?: string,
  origin?: 'human' | 'system',
): Queued[] {
  const trimmed = text.trim()
  if (trimmed === '') return queue
  return [
    ...queue,
    {
      id,
      text: trimmed,
      at,
      ...(where === undefined ? {} : { where }),
      ...(origin === undefined ? {} : { origin }),
    },
  ]
}

/** One message as the agent reads it, with its location when it has one. */
function line(message: Queued): string {
  return message.where === undefined ? message.text : `${message.where} — ${message.text}`
}

/** Withdraw one, for the message you regret before it has gone anywhere. */
export function dequeue(queue: Queued[], id: string): Queued[] {
  return queue.filter((message) => message.id !== id)
}

/**
 * How the queue reads to the agent.
 *
 * The preamble is load-bearing. Without it these arrive looking like a reply to whatever the
 * agent last said, when in fact they were written before it said it — so an instruction meant
 * for the task as a whole reads as a response to a specific claim, and the agent answers the
 * wrong question. Saying when they were written is what makes them usable.
 *
 * One message is a sentence; several are a list. Bulleting a single line makes a passing
 * remark look like a specification.
 */
export function queuedBlock(queue: Queued[]): string {
  if (queue.length === 0) return ''

  const preamble =
    queue.length === 1
      ? 'The human wrote this while you were working, so it is about the task rather than a reply to anything you have said:'
      : 'The human wrote these while you were working, in this order. They are about the task rather than replies to anything you have said:'

  const body =
    queue.length === 1
      ? queue[0] === undefined
        ? ''
        : line(queue[0])
      : queue.map((message) => `- ${line(message)}`).join('\n')

  return `${preamble}\n\n${body}`
}

/**
 * What the human actually said, for showing back to them.
 *
 * `queuedBlock` above is what the agent reads, preamble and system-composed text included; a
 * reader wants only their own words. Left in writing order, the same as `queuedBlock` — an
 * aside written first is still the earlier one when it is finally shown.
 */
export function humanText(queue: Queued[]): string {
  return queue
    .filter((message) => message.origin !== 'system')
    .map((message) => message.text)
    .join('\n\n')
}

/**
 * The queue in front of whatever else is being said.
 *
 * Leading rather than trailing, for the same reason notes lead: it was written first, and the
 * text it precedes — a rejection, or the next prompt — is what to do about it. A rejection
 * also ends with its own closing instruction, which should stay closing.
 */
export function promptAhead(queue: Queued[], text: string): string {
  const block = queuedBlock(queue)
  if (block === '') return text
  return text.trim() === '' ? block : `${block}\n\n${text}`
}
