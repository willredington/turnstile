import type { SessionStatus } from './types.ts'

/**
 * What the app is waiting on, said once so every surface renders the same answer.
 *
 * Nothing in Turnstile blocks on the human any more — the board is a plain diff with notes — so
 * the only interesting question is whether the agent is working. While it is, more changes are
 * coming and the prompt box queues rather than sends.
 */

type Party = 'agent' | 'nobody'

export type Waiting = {
  on: Party
  /** A few words for the status line. Present tense, no ellipsis — the spinner says that. */
  label: string
  /** One sentence saying what is happening. */
  detail: string
  /** Why the prompt box is closed, or empty when it is open. */
  closed: string
  /** Whether something is in flight, so a surface knows to show motion. */
  busy: boolean
}

export function waitingOn(status: SessionStatus): Waiting {
  if (status === 'starting') {
    return {
      on: 'nobody',
      label: 'starting',
      detail: 'Turnstile is still connecting to the agent.',
      closed: 'Connecting to the agent…',
      busy: true,
    }
  }

  if (status === 'working') {
    return {
      on: 'agent',
      label: 'agent is working',
      detail: 'The agent is still working, so more changes may arrive.',
      closed: 'The agent is working. You can write again when the turn ends.',
      busy: true,
    }
  }

  return {
    on: 'nobody',
    label: 'idle',
    detail: 'Nothing is waiting on anyone.',
    closed: '',
    busy: false,
  }
}
