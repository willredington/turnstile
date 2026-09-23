import { describe, expect, test } from 'bun:test'
import { boardKey } from '../../src/core/chunking.ts'
import { liveChunks, type ReviewView, toBoardKeys } from '../../src/core/livechunks.ts'
import type { Chunk, Finding } from '../../src/core/types.ts'

/**
 * The chunk list is derived whole from the board and each file's current review, so every rule
 * here is about what one of those says about a chunk — never about what a previous round left.
 */

const ROOT = '/repo'

function chunk(key: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    key,
    root: ROOT,
    path: 'src/a.ts',
    kind: 'modified',
    startLine: 10,
    endLine: 14,
    hunks: [],
    addedCount: 1,
    removedCount: 1,
    analyzable: true,
    wholeFile: false,
    ...overrides,
  } as Chunk
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: 'src/a.ts',
  startLine: 10,
  endLine: 10,
  severity: 'high',
  title: 'Dropped promise',
  message: 'The rejection is never handled.',
  ...overrides,
})

function view(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    analyzing: () => false,
    failure: () => undefined,
    findingsFor: () => null,
    ...overrides,
  }
}

const NO_SKIPS = new Map<string, string>()

describe('liveChunks', () => {
  test('a file with no current review is pending, with no analysis', () => {
    const { chunks } = liveChunks([chunk('a')], NO_SKIPS, view())
    expect(chunks[0]).toMatchObject({ status: 'pending', analysis: null, reason: null })
  })

  test("a file's current review puts each finding on the chunk it overlaps", () => {
    const { chunks, fileFindings } = liveChunks(
      [chunk('a'), chunk('b', { startLine: 40, endLine: 44 })],
      NO_SKIPS,
      view({ findingsFor: () => [finding()] }),
    )
    expect(chunks[0]?.status).toBe('ready')
    expect(chunks[0]?.analysis).toEqual({ riskLevel: 'high', findings: [finding()] })
    expect(chunks[1]).toMatchObject({
      status: 'ready',
      analysis: { riskLevel: 'none', findings: [] },
    })
    expect(fileFindings).toEqual([])
  })

  test('a review with no findings still reads as reviewed', () => {
    const { chunks } = liveChunks([chunk('a')], NO_SKIPS, view({ findingsFor: () => [] }))
    expect(chunks[0]).toMatchObject({
      status: 'ready',
      analysis: { riskLevel: 'none', findings: [] },
    })
  })

  test('findings on no chunk are file-level', () => {
    const outside = finding({ startLine: 90, endLine: 91 })
    const { fileFindings } = liveChunks(
      [chunk('a'), chunk('b', { startLine: 40, endLine: 44 })],
      NO_SKIPS,
      view({ findingsFor: () => [outside] }),
    )
    expect(fileFindings).toEqual([{ path: 'src/a.ts', findings: [outside] }])
  })

  test('a file under review is analyzing, keeping a current review on screen', () => {
    const { chunks } = liveChunks(
      [chunk('a')],
      NO_SKIPS,
      view({ analyzing: (path) => path === 'src/a.ts', findingsFor: () => [finding()] }),
    )
    expect(chunks[0]?.status).toBe('analyzing')
    expect(chunks[0]?.analysis?.findings).toEqual([finding()])
  })

  test('a failed review is pending and says why', () => {
    const { chunks } = liveChunks(
      [chunk('a')],
      NO_SKIPS,
      view({ failure: (path) => (path === 'src/a.ts' ? 'timed out' : undefined) }),
    )
    expect(chunks[0]).toMatchObject({ status: 'pending', reason: 'Review failed: timed out' })
  })

  test('a skip outranks a stored review', () => {
    const { chunks, fileFindings } = liveChunks(
      [chunk('a')],
      new Map([['src/a.ts', 'lockfile']]),
      view({ findingsFor: () => [finding({ startLine: 99, endLine: 99 })] }),
    )
    expect(chunks[0]).toMatchObject({ status: 'skipped', analysis: null, reason: 'lockfile' })
    expect(fileFindings).toEqual([])
  })

  test('an unanalyzable chunk is skipped with its own reason', () => {
    const { chunks } = liveChunks(
      [chunk('a', { kind: 'binary', analyzable: false })],
      NO_SKIPS,
      view(),
    )
    expect(chunks[0]).toMatchObject({ status: 'skipped', reason: 'binary file — not analyzed' })
  })
})

describe('toBoardKeys', () => {
  test('stamps the root into the key and keeps the bare one as contentKey', () => {
    const [live] = toBoardKeys(liveChunks([chunk('a')], NO_SKIPS, view()).chunks)
    expect(live?.key).toBe(boardKey(ROOT, 'a'))
    expect(live?.contentKey).toBe('a')
  })
})
