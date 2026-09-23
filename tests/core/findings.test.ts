import { describe, expect, test } from 'bun:test'
import { assignFindings, levelOf } from '../../src/core/findings.ts'
import type { Chunk, Finding } from '../../src/core/types.ts'

function chunk(key: string, startLine: number, endLine: number): Chunk {
  return {
    key,
    root: '/repo',
    path: 'src/a.ts',
    kind: 'modified',
    startLine,
    endLine,
    addedCount: 1,
    removedCount: 0,
    hunks: [],
    analyzable: true,
    wholeFile: false,
  }
}

function finding(startLine: number, endLine = startLine, path = 'src/a.ts'): Finding {
  return {
    path,
    startLine,
    endLine,
    severity: 'medium',
    title: 'A problem',
    message: `${path}:${startLine}`,
  }
}

describe('assignFindings', () => {
  const chunks = [chunk('a', 10, 14), chunk('b', 30, 30)]

  test('a finding lands on the chunk whose lines it overlaps', () => {
    const { byChunk, fileLevel } = assignFindings('src/a.ts', chunks, [
      finding(12),
      finding(28, 31),
    ])
    expect(byChunk.get('a')).toEqual([finding(12)])
    expect(byChunk.get('b')).toEqual([finding(28, 31)])
    expect(fileLevel).toEqual([])
  })

  test('every chunk has an entry, empty when nothing landed on it', () => {
    expect(assignFindings('src/a.ts', chunks, []).byChunk).toEqual(
      new Map([
        ['a', []],
        ['b', []],
      ]),
    )
  })

  test('one overlapping several chunks goes to the first', () => {
    const { byChunk } = assignFindings('src/a.ts', chunks, [finding(5, 40)])
    expect(byChunk.get('a')).toHaveLength(1)
    expect(byChunk.get('b')).toEqual([])
  })

  /** A lone change owns whatever it broke elsewhere — there is no other change to blame. */
  test('a finding in another file goes on the only change, when there is one', () => {
    const elsewhere = finding(12, 12, 'src/caller.ts')
    const { byChunk, fileLevel } = assignFindings('src/a.ts', [chunk('a', 10, 14)], [elsewhere])
    expect(byChunk.get('a')).toEqual([elsewhere])
    expect(fileLevel).toEqual([])
  })

  /** Kept, not dropped: unchanged code the change affects, or another file it breaks. */
  test('with several changes, unchanged lines and other files are file-level', () => {
    const outside = finding(20)
    const elsewhere = finding(12, 12, 'src/caller.ts')
    const { byChunk, fileLevel } = assignFindings('src/a.ts', chunks, [outside, elsewhere])
    expect(byChunk.get('a')).toEqual([])
    expect(fileLevel).toEqual([outside, elsewhere])
  })

  test('a reversed range still overlaps', () => {
    expect(assignFindings('src/a.ts', chunks, [finding(16, 11)]).byChunk.get('a')).toHaveLength(1)
  })
})

describe('levelOf', () => {
  test('is the worst severity, or none', () => {
    expect(levelOf([])).toBe('none')
    expect(
      levelOf([
        { ...finding(1), severity: 'low' },
        { ...finding(2), severity: 'high' },
        { ...finding(3), severity: 'medium' },
      ]),
    ).toBe('high')
  })
})
