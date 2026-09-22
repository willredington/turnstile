import { describe, expect, test } from 'bun:test'
import { type AskAnchor, anchorLabel, askPayload } from '../../src/core/ask.ts'

/**
 * What the asker is shown for one question.
 *
 * The properties that matter are all about bounding: the payload must never grow with the file,
 * must never elide the lines the question is actually about, and must number them the way the
 * file does — an answer citing "line 42" is wrong if the payload counted from somewhere else.
 */

/** A file of `count` lines, each naming its own number so numbering can be checked. */
function file(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')
}

function payload(
  overrides: {
    fileText?: string
    anchor?: AskAnchor
    history?: { question: string; answer: string }[]
    question?: string
  } = {},
): string {
  return askPayload({
    path: 'src/a.ts',
    fileText: overrides.fileText ?? file(10),
    anchor: overrides.anchor === undefined ? { startLine: 3, endLine: 4 } : overrides.anchor,
    history: overrides.history ?? [],
    question: overrides.question ?? 'What does this do?',
  })
}

describe('what the payload contains', () => {
  test('names the file and the lines the question is about', () => {
    expect(payload()).toContain('src/a.ts, lines 3–4')
  })

  test('a single-line selection reads as one line, not a range', () => {
    expect(payload({ anchor: { startLine: 3, endLine: 3 } })).toContain('src/a.ts, line 3')
  })

  test('a whole-file question says so', () => {
    expect(payload({ anchor: null })).toContain('The whole of src/a.ts.')
  })

  test('the question is last, so the most recent instruction is the freshest', () => {
    const out = payload({ question: 'Why is it like this?' })
    expect(out.trimEnd().endsWith('Why is it like this?')).toBe(true)
  })

  test('line numbers in the payload match the real file', () => {
    // Every line names its own number, so a numbering slip shows as a mismatch.
    expect(payload({ fileText: file(10), anchor: null })).toContain('7\tline 7')
  })
})

describe('the span of file it sends', () => {
  test('a small file is sent whole, however the question is anchored', () => {
    const out = payload({ fileText: file(10) })
    expect(out).toContain('1\tline 1')
    expect(out).toContain('10\tline 10')
    expect(out).toContain('(10 lines)')
  })

  test('a selection near the top does not underflow', () => {
    const out = payload({ fileText: file(5000), anchor: { startLine: 2, endLine: 3 } })
    expect(out).toContain('1\tline 1')
    expect(out).not.toContain('\t0\t')
  })

  test('a selection near the bottom does not overflow', () => {
    const out = payload({ fileText: file(5000), anchor: { startLine: 4999, endLine: 5000 } })
    expect(out).toContain('5000\tline 5000')
    expect(out).not.toContain('line 5001')
  })

  test('a selection in a large file sends a window, not the file', () => {
    const out = payload({ fileText: file(5000), anchor: { startLine: 2500, endLine: 2500 } })
    expect(out).toContain('2500\tline 2500')
    expect(out).toContain('2440\tline 2440')
    expect(out).not.toContain('1\tline 1\n')
    expect(out).toContain('5000 lines in all')
  })

  test('a whole-file question on a large file is capped rather than sending everything', () => {
    const out = payload({ fileText: file(5000), anchor: null })
    expect(out).toContain('1\tline 1')
    expect(out).toContain('1500\tline 1500')
    expect(out).not.toContain('1501\tline 1501')
    expect(out).toContain('read_file for the rest')
  })

  test('a selection larger than the budget is still sent whole', () => {
    // Trimming it would have the model answer about lines it was never shown.
    const out = payload({ fileText: file(5000), anchor: { startLine: 100, endLine: 3000 } })
    expect(out).toContain('100\tline 100')
    expect(out).toContain('3000\tline 3000')
  })

  test('line numbers stale past the end of the file are clamped, not trusted', () => {
    const out = payload({ fileText: file(10), anchor: { startLine: 8, endLine: 9000 } })
    expect(out).toContain('10\tline 10')
    expect(out).not.toContain('line 11')
  })
})

describe('a thread', () => {
  test('earlier exchanges reach the model, oldest first', () => {
    const out = payload({
      history: [
        { question: 'What is this?', answer: 'A tab key.' },
        { question: 'Why root?', answer: 'Two rows.' },
      ],
    })
    expect(out).toContain('Q: What is this?')
    expect(out).toContain('A: A tab key.')
    expect(out.indexOf('What is this?')).toBeLessThan(out.indexOf('Why root?'))
  })

  test('a first question carries no thread section', () => {
    expect(payload()).not.toContain('Earlier in this thread')
  })
})

describe('anchorLabel', () => {
  test('a range, a line, and the whole file each read plainly', () => {
    expect(anchorLabel({ startLine: 3, endLine: 7 })).toBe('lines 3–7')
    expect(anchorLabel({ startLine: 3, endLine: 3 })).toBe('line 3')
    expect(anchorLabel(null)).toBe('the whole file')
  })
})
