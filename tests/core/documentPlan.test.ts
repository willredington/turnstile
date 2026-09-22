import { describe, expect, test } from 'bun:test'
import { buildDocumentPlan, type DocumentRegion } from '../../src/core/documentPlan.ts'
import type { ParsedPatch, PatchHunk, PatchLine } from '../../src/core/types.ts'

function patchOf(hunks: PatchHunk[], kind: ParsedPatch['kind'] = 'modified'): ParsedPatch {
  return {
    kind,
    path: 'src/core/adjudication.ts',
    addedCount: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0),
    removedCount: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'remove').length, 0),
    hunks,
  }
}

const ctx = (old: number, next: number, text: string): PatchLine => ({
  kind: 'context',
  oldLine: old,
  newLine: next,
  text,
})
const add = (next: number, text: string): PatchLine => ({
  kind: 'add',
  oldLine: null,
  newLine: next,
  text,
})
const rem = (old: number, text: string): PatchLine => ({
  kind: 'remove',
  oldLine: old,
  newLine: null,
  text,
})

/** 30 lines, with line 12 rewritten — the same shape `document.test.ts` reads against. */
const FILE = Array.from({ length: 30 }, (_, i) => (i === 11 ? 'CHANGED' : `L${i + 1}`)).join('\n')

const ONE_CHANGE = patchOf([
  {
    oldStart: 11,
    newStart: 11,
    context: '',
    lines: [ctx(11, 11, 'L11'), rem(12, 'OLD12'), add(12, 'CHANGED'), ctx(13, 13, 'L13')],
  },
])

const REGION: DocumentRegion[] = [{ key: 'c1', startLine: 12, endLine: 12 }]

describe('buildDocumentPlan', () => {
  describe('bands', () => {
    test('announces each change once, above the first line it touches', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.bands).toHaveLength(1)
      expect(plan.bands[0]?.chunkKey).toBe('c1')
      expect(plan.bands[0]?.line).toBe(12)
    })

    test("a band reports the change's new-side span, removals excluded", () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.bands[0]).toMatchObject({ startLine: 12, endLine: 12, lineCount: 1 })
    })

    test('two changes get one band each', () => {
      const patch = patchOf([
        { oldStart: 4, newStart: 4, context: '', lines: [add(4, 'FIRST')] },
        { oldStart: 20, newStart: 21, context: '', lines: [add(21, 'SECOND')] },
      ])
      const regions: DocumentRegion[] = [
        { key: 'a', startLine: 4, endLine: 4 },
        { key: 'b', startLine: 21, endLine: 21 },
      ]
      const plan = buildDocumentPlan(FILE, patch, regions)
      expect(plan.bands.map((b) => [b.chunkKey, b.line])).toEqual([
        ['a', 4],
        ['b', 21],
      ])
    })

    test("an unchanged line between a change's hunks counts toward its span", () => {
      const patch = patchOf([
        { oldStart: 10, newStart: 10, context: '', lines: [add(10, 'X')] },
        { oldStart: 13, newStart: 14, context: '', lines: [add(14, 'Y')] },
      ])
      const regions: DocumentRegion[] = [{ key: 'c1', startLine: 10, endLine: 14 }]
      const plan = buildDocumentPlan(FILE, patch, regions)
      expect(plan.bands).toHaveLength(1)
      expect(plan.bands[0]).toMatchObject({ line: 10, startLine: 10, endLine: 14, lineCount: 5 })
    })
  })

  describe('accents', () => {
    test('an added line carries its change, marked as an addition', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.accents).toEqual([{ line: 12, kind: 'add', chunkKey: 'c1' }])
    })

    test("an unchanged line inside a change's range carries it as context", () => {
      const patch = patchOf([
        { oldStart: 10, newStart: 10, context: '', lines: [add(10, 'X')] },
        { oldStart: 13, newStart: 14, context: '', lines: [add(14, 'Y')] },
      ])
      const regions: DocumentRegion[] = [{ key: 'c1', startLine: 10, endLine: 14 }]
      const plan = buildDocumentPlan(FILE, patch, regions)
      expect(plan.accents).toEqual([
        { line: 10, kind: 'add', chunkKey: 'c1' },
        { line: 11, kind: 'context', chunkKey: 'c1' },
        { line: 12, kind: 'context', chunkKey: 'c1' },
        { line: 13, kind: 'context', chunkKey: 'c1' },
        { line: 14, kind: 'add', chunkKey: 'c1' },
      ])
    })

    test('a line outside every change carries no accent', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.accents.some((a) => a.line !== 12)).toBe(false)
    })
  })

  describe('removals', () => {
    test('keeps a removed line above the line that replaced it', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.removals).toEqual([
        { line: 12, chunkKey: 'c1', texts: ['OLD12'], oldLines: [12] },
      ])
    })

    test('consecutive removals stay one run, in order', () => {
      const patch = patchOf([
        {
          oldStart: 11,
          newStart: 11,
          context: '',
          lines: [ctx(11, 11, 'L11'), rem(12, 'A'), rem(13, 'B'), add(12, 'CHANGED')],
        },
      ])
      const plan = buildDocumentPlan(FILE, patch, REGION)
      expect(plan.removals).toEqual([
        { line: 12, chunkKey: 'c1', texts: ['A', 'B'], oldLines: [12, 13] },
      ])
    })

    test('two separated removals stay two runs', () => {
      const patch = patchOf([
        {
          oldStart: 11,
          newStart: 11,
          context: '',
          lines: [rem(11, 'A'), ctx(12, 11, 'L11'), rem(13, 'B'), ctx(14, 12, 'CHANGED')],
        },
      ])
      const plan = buildDocumentPlan(FILE, patch, REGION)
      expect(plan.removals.map((r) => [r.line, r.texts])).toEqual([
        [11, ['A']],
        [12, ['B']],
      ])
    })

    test('a removal ending a hunk sits after the last line that hunk touched', () => {
      const patch = patchOf([
        {
          oldStart: 20,
          newStart: 20,
          context: '',
          lines: [ctx(20, 20, 'L20'), rem(21, 'GONE1'), rem(22, 'GONE2')],
        },
      ])
      const regions: DocumentRegion[] = [{ key: 'z', startLine: 20, endLine: 20 }]
      const plan = buildDocumentPlan(FILE, patch, regions)
      expect(plan.removals).toEqual([
        { line: 21, chunkKey: 'z', texts: ['GONE1', 'GONE2'], oldLines: [21, 22] },
      ])
    })

    test('a removal from a hunk no change claims still keeps its place', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, [])
      expect(plan.removals).toEqual([
        { line: 12, chunkKey: null, texts: ['OLD12'], oldLines: [12] },
      ])
    })
  })

  describe('folding', () => {
    test('collapses a long unchanged run, keeping a margin either side', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      // 30 lines, only line 12 changed: the runs are 1–11 and 13–30, both past the threshold.
      expect(plan.folds).toEqual([
        { startLine: 4, endLine: 8, lineCount: 5 },
        { startLine: 16, endLine: 27, lineCount: 12 },
      ])
    })

    test('leaves a run no longer than the threshold alone', () => {
      const short = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
      const patch = patchOf([{ oldStart: 9, newStart: 9, context: '', lines: [add(9, 'L9')] }])
      const plan = buildDocumentPlan(short, patch, [{ key: 'c1', startLine: 9, endLine: 9 }])
      expect(plan.folds).toEqual([])
    })

    test("never folds a line inside a change's range", () => {
      const patch = patchOf([
        { oldStart: 10, newStart: 10, context: '', lines: [add(10, 'X')] },
        { oldStart: 13, newStart: 14, context: '', lines: [add(14, 'Y')] },
      ])
      const regions: DocumentRegion[] = [{ key: 'c1', startLine: 10, endLine: 14 }]
      const plan = buildDocumentPlan(FILE, patch, regions)
      const folded = plan.folds.flatMap((f) =>
        Array.from({ length: f.endLine - f.startLine + 1 }, (_, i) => f.startLine + i),
      )
      for (const line of [10, 11, 12, 13, 14]) expect(folded).not.toContain(line)
    })

    test('respects a caller-supplied threshold and margin', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION, 4, 1)
      expect(plan.folds).toEqual([
        { startLine: 2, endLine: 10, lineCount: 9 },
        { startLine: 14, endLine: 29, lineCount: 16 },
      ])
    })
  })

  describe('when the file and the patch disagree', () => {
    test('claims no line the file does not have', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, [{ key: 'c1', startLine: 40, endLine: 50 }])
      expect(plan.bands).toEqual([])
      expect(plan.accents).toEqual([])
    })

    test('clamps a change that runs off the end of the file', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, [{ key: 'c1', startLine: 28, endLine: 99 }])
      expect(plan.bands[0]).toMatchObject({ startLine: 28, endLine: 30, lineCount: 3 })
      expect(plan.accents.at(-1)?.line).toBe(30)
    })

    test('does not throw on an empty file', () => {
      expect(() => buildDocumentPlan('', ONE_CHANGE, REGION)).not.toThrow()
      expect(buildDocumentPlan('', ONE_CHANGE, REGION).folds).toEqual([])
    })

    test('a trailing newline does not add a phantom last line', () => {
      const plan = buildDocumentPlan(`${FILE}\n`, ONE_CHANGE, [
        { key: 'c1', startLine: 29, endLine: 31 },
      ])
      expect(plan.bands[0]).toMatchObject({ endLine: 30, lineCount: 2 })
    })
  })

  test('a created file is all additions', () => {
    const text = 'a\nb\nc'
    const patch = patchOf(
      [
        {
          oldStart: 0,
          newStart: 1,
          context: '',
          lines: [add(1, 'a'), add(2, 'b'), add(3, 'c')],
        },
      ],
      'created',
    )
    const plan = buildDocumentPlan(text, patch, [{ key: 'c1', startLine: 1, endLine: 3 }])
    expect(plan.accents.map((a) => a.kind)).toEqual(['add', 'add', 'add'])
    expect(plan.removals).toEqual([])
    expect(plan.folds).toEqual([])
  })

  describe('removals carry their old-side numbering', () => {
    test('so a note left on a removed line can be placed with it', () => {
      const plan = buildDocumentPlan(FILE, ONE_CHANGE, REGION)
      expect(plan.removals[0]?.oldLines).toEqual([12])
    })

    test('a run keeps one number per removed line, in order', () => {
      const patch = patchOf([
        {
          oldStart: 11,
          newStart: 11,
          context: '',
          lines: [ctx(11, 11, 'L11'), rem(12, 'A'), rem(13, 'B'), add(12, 'CHANGED')],
        },
      ])
      const plan = buildDocumentPlan(FILE, patch, REGION)
      expect(plan.removals[0]?.oldLines).toEqual([12, 13])
      expect(plan.removals[0]?.texts).toEqual(['A', 'B'])
    })
  })
})
