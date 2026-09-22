import { describe, expect, test } from 'bun:test'
import { type ChangedFile, marksByPath } from '../../../../src/adapters/web/ui/ChangedFiles.tsx'
import type { LiveChunk, RiskLevel } from '../../../../src/core/types.ts'

/**
 * What colour a changed file is, as the project tree and the tab strip both ask it.
 *
 * The point of the function is that there is only one of it: the two surfaces used to work the
 * answer out separately, and the tab strip is new enough that a second copy would have been the
 * obvious thing to write.
 */

const ROOT = '/repo'

function chunk(riskLevel: RiskLevel | null): LiveChunk {
  return {
    key: `k-${riskLevel ?? 'none'}`,
    root: ROOT,
    path: 'src/a.ts',
    kind: 'modified',
    startLine: 1,
    endLine: 2,
    status: riskLevel === null ? 'pending' : 'ready',
    reason: null,
    analysis: riskLevel === null ? null : { riskLevel, findings: [] },
  } as LiveChunk
}

function file(path: string, riskLevel: RiskLevel | null): ChangedFile {
  return {
    root: ROOT,
    path,
    kind: 'modified',
    added: 1,
    removed: 0,
    chunks: [chunk(riskLevel)],
    fileFindings: [],
  }
}

describe('what tints a changed file', () => {
  test('a file takes the rail section it sits in', () => {
    const marks = marksByPath([file('src/a.ts', 'high'), file('src/b.ts', 'low')], [])
    expect(marks.get('src/a.ts')).toBe('high')
    expect(marks.get('src/b.ts')).toBe('low')
  })

  test('one nothing has reviewed yet is marked as that, not as safe', () => {
    expect(marksByPath([file('src/a.ts', null)], []).get('src/a.ts')).toBe('unreviewed')
  })

  test('being marked reviewed wins over whatever the review made of it', () => {
    const risky = file('src/a.ts', 'high')
    expect(marksByPath([risky], [risky]).get('src/a.ts')).toBe('reviewed')
  })

  test('marking one reviewed leaves the others alone', () => {
    const read = file('src/a.ts', 'high')
    const marks = marksByPath([read, file('src/b.ts', 'high')], [read])
    expect(marks.get('src/a.ts')).toBe('reviewed')
    expect(marks.get('src/b.ts')).toBe('high')
  })

  test('a file that is not on the board has no mark at all', () => {
    expect(marksByPath([file('src/a.ts', 'high')], []).has('README.md')).toBe(false)
  })
})
