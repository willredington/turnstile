import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import {
  askedLines,
  type BlockWidgets,
  decorationsFor,
  headerDecoration,
} from '../../../../src/adapters/web/ui/editor/decorations.ts'
import type { DocumentPlan } from '../../../../src/core/documentPlan.ts'

/** Five lines, so a removal anchored at 6 is "past the end". */
const DOC = 'one\ntwo\nthree\nfour\nfive'

class Stub extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(other: Stub) {
    return other.label === this.label
  }
  toDOM(): HTMLElement {
    throw new Error('not rendered in tests')
  }
}

const widgets: BlockWidgets = {
  band: (band) => new Stub(`band:${band.chunkKey}`),
  removal: (removal) => new Stub(`removal:${removal.texts.join(',')}`),
  fold: (fold) => new Stub(`fold:${fold.startLine}-${fold.endLine}`),
}

const emptyPlan: DocumentPlan = { bands: [], accents: [], removals: [], folds: [] }

function entries(state: EditorState, plan: DocumentPlan) {
  const set = decorationsFor(state, plan, widgets)
  const out: { from: number; to: number; spec: string }[] = []
  const iter = set.iter()
  while (iter.value !== null) {
    const spec = iter.value.spec as { widget?: Stub; class?: string }
    out.push({
      from: iter.from,
      to: iter.to,
      spec: spec.widget?.label ?? spec.class ?? 'unknown',
    })
    iter.next()
  }
  return out
}

describe('decorationsFor', () => {
  const state = EditorState.create({ doc: DOC })

  test('an added line is marked where it sits', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      accents: [{ line: 2, kind: 'add', chunkKey: 'c1' }],
    }
    const found = entries(state, plan)
    expect(found).toHaveLength(1)
    expect(found[0]?.from).toBe(state.doc.line(2).from)
    expect(found[0]?.spec).toContain('add')
  })

  test('a band sits above the line it announces', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      bands: [{ chunkKey: 'c1', line: 3, startLine: 3, endLine: 3, lineCount: 1 }],
    }
    const found = entries(state, plan)
    expect(found).toEqual([
      { from: state.doc.line(3).from, to: state.doc.line(3).from, spec: 'band:c1' },
    ])
  })

  test('a removal sits above its anchor line', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      removals: [{ line: 2, chunkKey: 'c1', texts: ['gone'], oldLines: [2] }],
    }
    const found = entries(state, plan)
    expect(found[0]).toEqual({
      from: state.doc.line(2).from,
      to: state.doc.line(2).from,
      spec: 'removal:gone',
    })
  })

  test('a removal anchored past the last line lands at the end of the document', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      removals: [{ line: 6, chunkKey: null, texts: ['trailing'], oldLines: [6] }],
    }
    const found = entries(state, plan)
    expect(found).toHaveLength(1)
    expect(found[0]?.from).toBe(state.doc.length)
  })

  test('a fold replaces exactly the lines it hides', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      folds: [{ startLine: 2, endLine: 4, lineCount: 3 }],
    }
    const found = entries(state, plan)
    expect(found).toEqual([
      { from: state.doc.line(2).from, to: state.doc.line(4).to, spec: 'fold:2-4' },
    ])
  })

  test('interleaved bands, accents, removals and folds all survive', () => {
    const plan: DocumentPlan = {
      bands: [{ chunkKey: 'c1', line: 2, startLine: 2, endLine: 2, lineCount: 1 }],
      accents: [{ line: 2, kind: 'add', chunkKey: 'c1' }],
      removals: [{ line: 2, chunkKey: 'c1', texts: ['old'], oldLines: [2] }],
      folds: [{ startLine: 4, endLine: 5, lineCount: 2 }],
    }
    expect(() => decorationsFor(state, plan, widgets)).not.toThrow()
    expect(entries(state, plan)).toHaveLength(4)
  })

  test('an unchanged line inside a change is not tinted', () => {
    // The change's span is what the band reports; the line itself reads as ordinary context,
    // the same as it did before CodeMirror. Tinting every in-range line would also put a
    // decoration on every line of a large change for no visible result.
    const plan: DocumentPlan = {
      ...emptyPlan,
      accents: [
        { line: 2, kind: 'add', chunkKey: 'c1' },
        { line: 3, kind: 'context', chunkKey: 'c1' },
      ],
    }
    const found = entries(state, plan)
    expect(found).toHaveLength(1)
    expect(found[0]?.from).toBe(state.doc.line(2).from)
  })
})

describe('the card above the whole document', () => {
  const state = EditorState.create({ doc: DOC })

  test('it sits at the very start, taking up no text', () => {
    const range = headerDecoration(new Stub('findings'))
    expect(range.from).toBe(0)
    expect(range.to).toBe(0)
  })

  test('it is a block, so the document starts below it rather than beside it', () => {
    const range = headerDecoration(new Stub('findings'))
    expect((range.value.spec as { block?: boolean }).block).toBe(true)
  })

  // The only other block decoration that can land on offset 0 is a band for a hunk that
  // starts on line 1. File-level findings are about the file, not that hunk, so they belong
  // above it.
  test('it sorts above a band that starts on the first line', () => {
    const plan: DocumentPlan = {
      ...emptyPlan,
      bands: [{ chunkKey: 'c1', line: 1, startLine: 1, endLine: 1, lineCount: 1 }],
    }
    const banded = decorationsFor(state, plan, widgets)
    const set = banded.update({ add: [headerDecoration(new Stub('findings'))], sort: true })

    const labels: string[] = []
    const iter = set.iter()
    while (iter.value !== null) {
      labels.push((iter.value.spec as { widget?: Stub }).widget?.label ?? 'unknown')
      iter.next()
    }
    expect(labels).toEqual(['findings', 'band:c1'])
  })
})

describe('the lines a question is about', () => {
  const state = EditorState.create({ doc: DOC })
  const lines = (span: { startLine: number; endLine: number }) =>
    askedLines(state, span).map((range) => state.doc.lineAt(range.from).number)

  test('one line is marked at its start, taking up no text', () => {
    const marked = askedLines(state, { startLine: 2, endLine: 2 })
    expect(marked).toHaveLength(1)
    const only = marked[0]
    if (only === undefined) throw new Error('expected one marked line')
    expect(only.from).toBe(state.doc.line(2).from)
    expect(only.to).toBe(state.doc.line(2).from)
    expect((only.value.spec as { class?: string }).class).toBe('ts-asked')
  })

  test('every line in a range is marked, not just its ends', () => {
    expect(lines({ startLine: 2, endLine: 4 })).toEqual([2, 3, 4])
  })

  // The file can shrink under a question: it is anchored to line numbers, and nothing retires
  // it when those numbers stop existing.
  test('a range running past the end stops at the last line', () => {
    expect(lines({ startLine: 4, endLine: 99 })).toEqual([4, 5])
  })

  test('a range entirely past the end marks nothing', () => {
    expect(lines({ startLine: 9, endLine: 12 })).toEqual([])
  })

  test('an inverted range marks nothing', () => {
    expect(lines({ startLine: 4, endLine: 2 })).toEqual([])
  })
})
