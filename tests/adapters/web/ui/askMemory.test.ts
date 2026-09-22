import { beforeEach, describe, expect, test } from 'bun:test'
import {
  closeThread,
  continueThread,
  failThread,
  forgetAllThreads,
  recallThreads,
  settleThread,
  startThread,
  subscribeThreads,
} from '../../../../src/adapters/web/ui/editor/askMemory.ts'

/**
 * The questions asked about each tab.
 *
 * Two properties carry the feature: a thread survives its tab being switched away from (which
 * unmounts everything else holding it), and one tab's threads never reach another's — the same
 * per-tab identity `scrollMemory` keeps.
 */

beforeEach(forgetAllThreads)

const ANCHOR = { startLine: 3, endLine: 4 }

describe('asking', () => {
  test('a tab nobody has asked about has no threads', () => {
    expect(recallThreads('never-opened.ts')).toEqual([])
  })

  test('a new question is pending, with nothing answered yet', () => {
    startThread('a.ts', { anchor: ANCHOR, quote: 'const a = 1', question: 'Why?' })
    const [thread] = recallThreads('a.ts')
    expect(thread?.pending).toBe('Why?')
    expect(thread?.turns).toEqual([])
    expect(thread?.error).toBeNull()
  })

  test('an answer settles the question into the thread', () => {
    const id = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Why?' })
    settleThread('a.ts', id, 'Because.')
    const [thread] = recallThreads('a.ts')
    expect(thread?.turns).toEqual([{ question: 'Why?', answer: 'Because.' }])
    expect(thread?.pending).toBeNull()
  })

  test('a follow-up keeps what came before, which is what gives it context', () => {
    const id = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'What?' })
    settleThread('a.ts', id, 'A tab key.')
    continueThread('a.ts', id, 'Why root?')
    settleThread('a.ts', id, 'Two rows.')
    expect(recallThreads('a.ts')[0]?.turns).toEqual([
      { question: 'What?', answer: 'A tab key.' },
      { question: 'Why root?', answer: 'Two rows.' },
    ])
  })

  test('several threads on one tab are kept apart', () => {
    const first = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'One?' })
    startThread('a.ts', { anchor: null, quote: '', question: 'Two?' })
    settleThread('a.ts', first, 'Answered.')

    const threads = recallThreads('a.ts')
    expect(threads).toHaveLength(2)
    expect(threads[0]?.turns).toHaveLength(1)
    expect(threads[1]?.pending).toBe('Two?')
  })

  // The board's row and the reader's row key differently on purpose.
  test('two tabs do not see each other', () => {
    startThread('/repo\0c.ts', { anchor: ANCHOR, quote: 'x', question: 'Board?' })
    startThread('c.ts', { anchor: ANCHOR, quote: 'x', question: 'Reader?' })
    expect(recallThreads('/repo\0c.ts')[0]?.pending).toBe('Board?')
    expect(recallThreads('c.ts')[0]?.pending).toBe('Reader?')
  })

  test('closing one thread leaves the rest alone', () => {
    const first = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'One?' })
    startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Two?' })
    closeThread('a.ts', first)
    expect(recallThreads('a.ts').map((thread) => thread.pending)).toEqual(['Two?'])
  })
})

describe('when a question cannot be answered', () => {
  /** The question is kept so the reader can see which one failed and send it again. */
  test('the failed question stays pending, with the reason beside it', () => {
    const id = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Why?' })
    failThread('a.ts', id, 'OPENROUTER_API_KEY is not set.')
    const [thread] = recallThreads('a.ts')
    expect(thread?.pending).toBe('Why?')
    expect(thread?.error).toBe('OPENROUTER_API_KEY is not set.')
  })

  test('sending it again clears the reason, so the card stops showing a stale failure', () => {
    const id = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Why?' })
    failThread('a.ts', id, 'nope')
    continueThread('a.ts', id, 'Why?')
    expect(recallThreads('a.ts')[0]?.error).toBeNull()
  })
})

describe('what React subscribes to', () => {
  test('the snapshot keeps its identity while nothing changes, so a render loop cannot start', () => {
    startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Why?' })
    expect(recallThreads('a.ts')).toBe(recallThreads('a.ts'))
  })

  test('every change notifies, and unsubscribing stops it', () => {
    let calls = 0
    const stop = subscribeThreads(() => {
      calls += 1
    })
    const id = startThread('a.ts', { anchor: ANCHOR, quote: 'x', question: 'Why?' })
    settleThread('a.ts', id, 'Because.')
    expect(calls).toBe(2)

    stop()
    closeThread('a.ts', id)
    expect(calls).toBe(2)
  })
})
