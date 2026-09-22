import { describe, expect, test } from 'bun:test'
import { waitingOn } from '../../src/core/waiting.ts'

/**
 * Whose move it is.
 *
 * The rule is small, but it is the one thing every surface has to agree on: a status line
 * that says "idle" and a prompt box that says "the agent is working" cannot both be right,
 * and getting that wrong reads to the user as a broken screen rather than a wait.
 */

describe('who the app is waiting on', () => {
  test('the agent, while it is still producing changes', () => {
    const waiting = waitingOn('working')
    expect(waiting.on).toBe('agent')
    expect(waiting.busy).toBe(true)
  })

  test('nobody, when the session is idle', () => {
    const waiting = waitingOn('idle')
    expect(waiting.on).toBe('nobody')
    expect(waiting.busy).toBe(false)
  })

  test('nobody in particular while still connecting, but something is happening', () => {
    const waiting = waitingOn('starting')
    expect(waiting.on).toBe('nobody')
    expect(waiting.busy).toBe(true)
  })

  /** Every state has something to say, or a surface rendering it shows an empty box. */
  test('always says something', () => {
    for (const status of ['starting', 'idle', 'working'] as const) {
      const waiting = waitingOn(status)
      expect(waiting.label).not.toBe('')
      expect(waiting.detail).not.toBe('')
    }
  })

  /**
   * The prompt box and the status line ask different questions, so the reason the box is
   * closed is its own sentence rather than a reuse of the status detail.
   */
  test('says why input is closed separately from what is happening', () => {
    for (const status of ['starting', 'working'] as const) {
      const waiting = waitingOn(status)
      expect(waiting.closed).not.toBe('')
      expect(waiting.closed).not.toBe(waiting.detail)
    }
  })

  /** Nothing is blocked when nothing is happening, so there is nothing to explain. */
  test('has nothing to say about a box that is not closed', () => {
    expect(waitingOn('idle').closed).toBe('')
  })
})
