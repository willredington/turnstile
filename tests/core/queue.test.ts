import { describe, expect, test } from 'bun:test'
import {
  dequeue,
  enqueue,
  humanText,
  promptAhead,
  type Queued,
  queuedBlock,
} from '../../src/core/queue.ts'

/**
 * Messages written while the agent was busy.
 *
 * The rules are about not misrepresenting them: they were written before the agent finished,
 * so they must not reach it looking like a reply to its conclusion, and they must not be lost
 * between the turn that was running and the one that follows.
 */

function message(id: string, text: string): Queued {
  return { id, text, at: '2026-09-01T12:00:00.000Z' }
}

describe('queueing', () => {
  test('keeps what was written, in the order it was written', () => {
    const queue = enqueue(enqueue([], 'first', 'a', 'now'), 'second', 'b', 'now')
    expect(queue.map((m) => m.text)).toEqual(['first', 'second'])
  })

  test('trims, because trailing whitespace is not part of what was said', () => {
    expect(enqueue([], '  hello  ', 'a', 'now')[0]?.text).toBe('hello')
  })

  /** An empty send is not a message, and queueing one would show a blank row to withdraw. */
  test('queues nothing for blank text', () => {
    expect(enqueue([], '   ', 'a', 'now')).toEqual([])
  })

  test('withdraws one without disturbing the rest', () => {
    const queue = [message('a', 'first'), message('b', 'second')]
    expect(dequeue(queue, 'a').map((m) => m.text)).toEqual(['second'])
  })

  test('withdrawing something that is not there changes nothing', () => {
    const queue = [message('a', 'first')]
    expect(dequeue(queue, 'gone')).toEqual(queue)
  })
})

describe('how it reads to the agent', () => {
  test('nothing at all, when nothing is queued', () => {
    expect(queuedBlock([])).toBe('')
  })

  /**
   * The preamble is the point. Without it a message written mid-turn arrives looking like a
   * response to whatever the agent last said — so an instruction about the task gets answered
   * as though it were an objection to a specific claim.
   */
  test('says when it was written', () => {
    expect(queuedBlock([message('a', 'use the existing db helper')])).toContain(
      'while you were working',
    )
  })

  test('a single message is a sentence, not a list', () => {
    expect(queuedBlock([message('a', 'use the existing db helper')])).not.toContain('- use')
  })

  test('several are a list, in the order they were written', () => {
    const block = queuedBlock([message('a', 'first'), message('b', 'second')])
    expect(block).toContain('- first')
    expect(block).toContain('- second')
    expect(block.indexOf('- first')).toBeLessThan(block.indexOf('- second'))
  })
})

describe('composing the prompt', () => {
  test('the queue leads, because it was written first', () => {
    const composed = promptAhead(
      [message('a', 'use the db helper')],
      'Send this back: it is wrong.',
    )
    expect(composed.indexOf('use the db helper')).toBeLessThan(composed.indexOf('Send this back'))
  })

  /**
   * A rejection ends with its own closing instruction. Trailing the queue after it would put
   * the human's aside between that instruction and the agent reading it.
   */
  test('keeps the trailing text trailing', () => {
    const composed = promptAhead([message('a', 'note')], 'do the thing\n\nRevise forward.')
    expect(composed.endsWith('Revise forward.')).toBe(true)
  })

  test('an empty queue leaves the text exactly as it was', () => {
    expect(promptAhead([], 'do the thing')).toBe('do the thing')
  })

  /** A queue with nothing else to say is the whole prompt. */
  test('stands alone when there is no other text', () => {
    expect(promptAhead([message('a', 'add tests')], '')).toBe(
      queuedBlock([message('a', 'add tests')]),
    )
  })
})

/**
 * A message about one change has to say which change.
 *
 * Sending back "use the existing error style" with no location is the content-hash problem in
 * a new costume: the agent is told what is wrong and left to work out where.
 */
describe('a message about particular lines', () => {
  const located: Queued = {
    id: 'a',
    text: 'use the existing error style',
    at: '2026-09-01T12:00:00.000Z',
    where: 'src/orders.ts:9-18',
  }

  test('names them', () => {
    expect(queuedBlock([located])).toContain('src/orders.ts:9-18')
  })

  test('keeps what was said alongside where', () => {
    expect(queuedBlock([located])).toContain('use the existing error style')
  })

  test('still names them in a list', () => {
    const block = queuedBlock([located, message('b', 'and add tests')])
    expect(block).toContain('- src/orders.ts:9-18 — use the existing error style')
    expect(block).toContain('- and add tests')
  })

  test('a message about nothing in particular carries no location', () => {
    expect(enqueue([], 'add tests', 'a', 'now')[0]?.where).toBeUndefined()
  })
})

/**
 * Not everything in the queue was typed by a human. A per-edit rejection composes its own
 * reasoning for the agent — real text that must still reach it, but never something the human
 * said, and it must not be shown back to them as if it were.
 */
describe('who it is from', () => {
  test('a plain message is not marked as composed for the agent', () => {
    expect(enqueue([], 'add tests', 'a', 'now')[0]?.origin).not.toBe('system')
  })

  test('can be marked as composed for the agent rather than typed by a human', () => {
    const queue = enqueue([], 'A human reviewed your changes...', 'a', 'now', undefined, 'system')
    expect(queue[0]?.origin).toBe('system')
  })
})

/**
 * What actually goes back to the reader as "what you said" — as opposed to `queuedBlock`,
 * which is what the agent reads and includes everything, system-composed text included.
 */
describe('what the human actually said', () => {
  test('nothing, when nothing is queued', () => {
    expect(humanText([])).toBe('')
  })

  test('a human-typed message reads as itself', () => {
    expect(humanText([message('a', 'add tests')])).toBe('add tests')
  })

  test('several human messages join the same way they were written, in order', () => {
    expect(humanText([message('a', 'first'), message('b', 'second')])).toBe('first\n\nsecond')
  })

  test('leaves out anything composed for the agent', () => {
    const queue = enqueue(
      [message('a', 'add tests')],
      'A human reviewed your changes...',
      'b',
      'now',
      undefined,
      'system',
    )
    expect(humanText(queue)).toBe('add tests')
  })

  test('nothing at all, when everything queued was composed for the agent', () => {
    const queue = enqueue([], 'A human reviewed your changes...', 'a', 'now', undefined, 'system')
    expect(humanText(queue)).toBe('')
  })
})
