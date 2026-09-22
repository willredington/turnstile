import { describe, expect, test } from 'bun:test'
import {
  annotationsBlock,
  changedSince,
  contentHash,
  noteFileKey,
  notesForFile,
  orphanedAnnotations,
  planRefusal,
  promptWith,
  staleNotes,
  unsent,
} from '../../src/core/annotations.ts'
import type { Annotation } from '../../src/core/types.ts'

/**
 * Notes on lines, and how they reach the agent.
 *
 * Every rule here is about not putting something in front of the agent that the human did
 * not mean it to have: not twice, not without saying where it is, and not stripped of the
 * order it was written in.
 */

function note(overrides: Partial<Annotation> = {}): Annotation {
  const line = overrides.line ?? 14
  return {
    id: 'n1',
    sessionId: 'sess-1',
    root: '/repo',
    path: 'src/orders.ts',
    line,
    rangeStart: line,
    side: 'new',
    lineText: '  return total * 0.9',
    body: 'this should use the constant',
    at: '2026-09-01T12:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

describe('what is outstanding', () => {
  test('a note nobody has been told about', () => {
    expect(unsent([note()])).toHaveLength(1)
  })

  /** Delivered twice reads as a second complaint about the same line. */
  test('a delivered one is not sent again', () => {
    expect(unsent([note({ sentAt: '2026-09-01T13:00:00.000Z' })])).toEqual([])
  })

  /**
   * A reader writes notes in the order they read the diff, and that order is an argument.
   * Reshuffling hands the agent the same sentences with the reasoning taken out.
   */
  test('order follows when they were written', () => {
    const later = note({ id: 'n2', at: '2026-09-01T12:05:00.000Z', body: 'second' })
    const earlier = note({ id: 'n1', at: '2026-09-01T12:00:00.000Z', body: 'first' })

    expect(unsent([later, earlier]).map((n) => n.body)).toEqual(['first', 'second'])
  })
})

describe('one file’s notes', () => {
  test('keeps only that file’s notes, oldest first', () => {
    const notes = [
      note({ id: 'b', at: '2026-09-01T12:05:00.000Z', body: 'second' }),
      note({ id: 'c', path: 'src/other.ts', body: 'another file' }),
      note({ id: 'a', at: '2026-09-01T12:00:00.000Z', body: 'first' }),
    ]

    expect(notesForFile(notes, '/repo', 'src/orders.ts').map((n) => n.body)).toEqual([
      'first',
      'second',
    ])
  })

  /** The same relative path in two worktrees is two different files. */
  test('matches on root as well as path', () => {
    const notes = [note({ id: 'a', root: '/elsewhere' })]
    expect(notesForFile(notes, '/repo', 'src/orders.ts')).toEqual([])
  })
})

/**
 * A note on a file that has left the board — the agent reverted the change, say — has nowhere
 * to sit. Without a list of its own it is invisible, and still sendable.
 */
describe('orphaned notes', () => {
  test('are the ones whose file is no longer on the board, oldest first', () => {
    const notes = [
      note({ id: 'a', body: 'file still here' }),
      note({ id: 'c', path: 'src/left.ts', at: '2026-09-01T12:05:00.000Z', body: 'second' }),
      note({ id: 'b', path: 'src/gone.ts', at: '2026-09-01T12:00:00.000Z', body: 'first' }),
    ]

    const files = [{ root: '/repo', path: 'src/orders.ts' }]
    expect(orphanedAnnotations(notes, files).map((n) => n.body)).toEqual(['first', 'second'])
  })

  test('a file with the same path under another root does not keep a note anchored', () => {
    const files = [{ root: '/elsewhere', path: 'src/orders.ts' }]
    expect(orphanedAnnotations([note()], files)).toHaveLength(1)
  })

  test('on an empty board, every note is orphaned', () => {
    expect(orphanedAnnotations([note()], [])).toHaveLength(1)
  })

  test('none are, when the board still holds every file', () => {
    expect(orphanedAnnotations([note()], [{ root: '/repo', path: 'src/orders.ts' }])).toEqual([])
  })
})

/**
 * An agent that cannot locate a note cannot act on it — the lesson from handing one a content
 * hash and watching it go read Turnstile's own cache to decode it.
 */
describe('what the agent is handed', () => {
  test('names the file and line of every note', () => {
    const block = annotationsBlock([note()])
    expect(block).toContain('src/orders.ts:14 — this should use the constant')
  })

  /** The agent has the file, but not the version of it the human was looking at. */
  test('quotes the line as it read when the note was written', () => {
    expect(annotationsBlock([note()])).toContain('    > return total * 0.9')
  })

  test('says nothing at all when there is nothing to say', () => {
    expect(annotationsBlock([])).toBe('')
  })

  test('opens by saying what the notes are', () => {
    expect(annotationsBlock([note()]).startsWith('The human left notes on specific lines:')).toBe(
      true,
    )
  })

  test('carries several notes in one block, in the order given', () => {
    const block = annotationsBlock([note(), note({ id: 'n2', line: 20, body: 'and this' })])
    expect(block.indexOf('src/orders.ts:14')).toBeLessThan(block.indexOf('src/orders.ts:20'))
  })

  test('names the whole span for a note left on more than one line', () => {
    const block = annotationsBlock([note({ rangeStart: 12, line: 14, lineText: 'a\nb\nc' })])
    expect(block).toContain('src/orders.ts:12-14')
    expect(block).toContain('    > a\n    > b\n    > c')
  })

  /** A note on a removed line points at a line the agent can no longer find in the file. */
  test('says when the line is one the agent removed', () => {
    const block = annotationsBlock([note({ side: 'old' })])
    expect(block).toContain('src/orders.ts:14 (a line you removed) — ')
  })

  test('and says nothing of the sort about a line that is still there', () => {
    expect(annotationsBlock([note()])).not.toContain('removed')
  })
})

describe('attaching notes to a message', () => {
  /** The notes are the correction; the typed message is what to do about it. */
  test('notes lead, the message follows', () => {
    expect(promptWith([note()], 'now add the tests')).toBe(
      `${annotationsBlock([note()])}\n\nnow add the tests`,
    )
  })

  test('a message with no notes is passed through untouched', () => {
    expect(promptWith([], 'just this')).toBe('just this')
  })

  /** Notes are themselves something to say. */
  test('notes with no message stand on their own', () => {
    expect(promptWith([note()], '')).toBe(annotationsBlock([note()]))
  })

  test('and with only whitespace typed', () => {
    expect(promptWith([note()], '   ')).toBe(annotationsBlock([note()]))
  })
})

/** A note is anchored to a line number; once its file changes, that number may point elsewhere. */
describe('notes whose lines have changed', () => {
  /**
   * A note quotes the lines it was written about, so it can be checked against exactly those
   * lines rather than against the whole file. Editing elsewhere — including editing the file
   * yourself — leaves it alone; only a change to the lines it is actually about retires it.
   */
  const FILE = [
    'export function total(items: Item[]): number {',
    '  let total = 0',
    '  for (const item of items) total += item.price',
    '  return total * 0.9',
    '}',
  ].join('\n')

  const before = contentHash(FILE)
  const texts = (content: string | null) =>
    new Map([[noteFileKey('/repo', 'src/orders.ts'), content]])

  /** Anchored on line 4, `  return total * 0.9` — the line the default note quotes. */
  const onLine4 = (overrides: Partial<Annotation> = {}) =>
    note({ line: 4, rangeStart: 4, fileHash: before, ...overrides })

  test('a note survives a change elsewhere in the file', () => {
    const edited = FILE.replace('  let total = 0', '  let total = 0 // running sum')
    expect(staleNotes([onLine4()], texts(edited))).toEqual([])
  })

  test('a note goes when the lines it quoted change', () => {
    const edited = FILE.replace('  return total * 0.9', '  return total * DISCOUNT')
    expect(staleNotes([onLine4()], texts(edited))).toHaveLength(1)
  })

  test('a note goes when its lines shift to a different place in the file', () => {
    const edited = `// added a header line\n${FILE}`
    expect(staleNotes([onLine4()], texts(edited))).toHaveLength(1)
  })

  test('a note goes when the file no longer reaches its lines', () => {
    expect(staleNotes([onLine4()], texts('one\ntwo'))).toHaveLength(1)
  })

  test('sent or not makes no difference', () => {
    const edited = FILE.replace('  return total * 0.9', '  return total')
    const notes = [onLine4(), onLine4({ id: 'n2', sentAt: 'x' })]
    expect(staleNotes(notes, texts(edited)).map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  test('a note on several lines survives while all of them are unchanged', () => {
    const multi = onLine4({
      rangeStart: 2,
      line: 4,
      lineText: [
        '  let total = 0',
        '  for (const item of items) total += item.price',
        '  return total * 0.9',
      ].join('\n'),
    })
    const edited = FILE.replace('}', '}\n')
    expect(staleNotes([multi], texts(edited))).toEqual([])
  })

  test('a note on several lines goes when any one of them changed', () => {
    const multi = onLine4({
      rangeStart: 2,
      line: 4,
      lineText: [
        '  let total = 0',
        '  for (const item of items) total += item.price',
        '  return total * 0.9',
      ].join('\n'),
    })
    const edited = FILE.replace('  let total = 0', '  let total = 1')
    expect(staleNotes([multi], texts(edited))).toHaveLength(1)
  })

  /**
   * A removed line is not in the file at all, so nothing in the file can confirm it is still
   * the line the note is about — the diff it came from is the only thing that knows, and that
   * is rebuilt on any change. So an old-side note keeps the whole-file rule.
   */
  test('a note on a removed line goes on any change to the file', () => {
    const removed = onLine4({ side: 'old', lineText: '  return total' })
    const edited = FILE.replace('  let total = 0', '  let total = 0 // elsewhere')
    expect(staleNotes([removed], texts(edited))).toHaveLength(1)
  })

  test('a note on a removed line stays while the file is untouched', () => {
    const removed = onLine4({ side: 'old', lineText: '  return total' })
    expect(staleNotes([removed], texts(FILE))).toEqual([])
  })

  test('a note on a deleted file goes', () => {
    expect(staleNotes([onLine4()], texts(null))).toHaveLength(1)
  })

  /** Written before notes recorded a hash: nothing to compare, so it stays. */
  test('a note with no recorded hash is kept', () => {
    expect(staleNotes([note({ line: 4, rangeStart: 4 })], texts('anything else'))).toEqual([])
  })

  /** Unreadable is not the same as changed. */
  test('a note whose file could not be read is kept', () => {
    expect(staleNotes([onLine4()], new Map())).toEqual([])
  })
})

/** A hidden file is checked the same way: any change to it since it was hidden shows it again. */
describe('hidden files whose file has changed', () => {
  const before = contentHash('a\n')
  const hidden = { root: '/repo', path: 'src/orders.ts', fileHash: before }
  const current = (content: string | null) =>
    new Map([[noteFileKey('/repo', 'src/orders.ts'), contentHash(content)]])

  test('unchanged, it stays hidden', () => {
    expect(changedSince([hidden], current('a\n'))).toEqual([])
  })

  test('changed or deleted, it comes back', () => {
    expect(changedSince([hidden], current('b\n'))).toEqual([hidden])
    expect(changedSince([hidden], current(null))).toEqual([hidden])
  })

  test('unreadable, it stays hidden', () => {
    expect(changedSince([hidden], new Map())).toEqual([])
  })
})

/**
 * Notes on a plan, as the refusal the agent is handed.
 *
 * Different from `annotationsBlock` in the two ways that matter: it is a tool result rather than
 * a prompt, so it has to say what happened before it says why; and it is about a document with
 * no file behind it, so it names lines rather than paths.
 */
describe('refusing a plan', () => {
  const step = (overrides: Partial<Annotation> = {}): Annotation =>
    note({
      path: 'the plan',
      root: '',
      lineText: '3. Migrate the store',
      line: 3,
      rangeStart: 3,
      ...overrides,
    })

  test('says the plan was not accepted before it says why', () => {
    expect(planRefusal([step()], '').startsWith('The human did not accept this plan')).toBe(true)
  })

  test('names lines, never the stand-in path', () => {
    const refusal = planRefusal([step()], '')
    expect(refusal).toContain('line 3 — this should use the constant')
    expect(refusal).not.toContain('the plan:')
  })

  test('a range reads as a range', () => {
    expect(planRefusal([step({ rangeStart: 3, line: 5 })], '')).toContain('lines 3-5')
  })

  test('quotes the lines the note was left on', () => {
    expect(planRefusal([step()], '')).toContain('    > 3. Migrate the store')
  })

  test('the message follows the notes', () => {
    const refusal = planRefusal([step()], 'drop step 3')
    expect(refusal.indexOf('line 3')).toBeLessThan(refusal.indexOf('drop step 3'))
  })

  test('a message on its own needs no preamble about notes there are none of', () => {
    const refusal = planRefusal([], '  start over  ')
    expect(refusal.startsWith('start over')).toBe(true)
    expect(refusal).not.toContain('left notes on it')
  })

  /**
   * The objections alone read as a remark, and got treated as one: handed a plan's notes, the
   * agent discussed them, asked a clarifying question, and submitted nothing — so no revised
   * plan could ever arrive and the reader was left with no plan at all.
   */
  test('every refusal asks for a revised plan, by the one route that can be reviewed', () => {
    for (const refusal of [
      planRefusal([step()], ''),
      planRefusal([], 'start over'),
      planRefusal([step()], 'start over'),
    ]) {
      expect(refusal).toContain('submit the new version with ExitPlanMode')
      expect(refusal).toContain('do not reply with the changes in prose')
    }
  })

  test('the instruction comes last, after what is wrong', () => {
    const refusal = planRefusal([step()], 'start over')
    expect(refusal.indexOf('this should use the constant')).toBeLessThan(
      refusal.indexOf('ExitPlanMode'),
    )
    expect(refusal.indexOf('start over')).toBeLessThan(refusal.indexOf('ExitPlanMode'))
  })

  test('nothing to say is still nothing, not a bare instruction', () => {
    expect(planRefusal([], '   ')).toBe('')
  })

  test('neither is nothing at all', () => {
    expect(planRefusal([], '   ')).toBe('')
  })

  test('notes keep the order they were written in', () => {
    const refusal = planRefusal(
      [
        step({ id: 'n2', line: 9, body: 'and this', at: '2026-09-01T12:05:00.000Z' }),
        step({ id: 'n1', line: 3, body: 'this first', at: '2026-09-01T12:00:00.000Z' }),
      ],
      '',
    )
    expect(refusal.indexOf('this first')).toBeLessThan(refusal.indexOf('and this'))
  })
})
