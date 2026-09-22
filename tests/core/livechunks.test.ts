import { describe, expect, test } from 'bun:test'
import { boardKey } from '../../src/core/chunking.ts'
import {
  markAnalyzing,
  markFailed,
  markReady,
  markSkipped,
  reconcile,
  toBoardKeys,
} from '../../src/core/livechunks.ts'
import type { Chunk, ChunkAnalysis, LiveChunk } from '../../src/core/types.ts'

/**
 * The chunk list is recomputed on every edit, so every rule here is about not losing
 * something across that recompute. Each failure looks the same from the outside — a spinner
 * that never stops, or a finished analysis that flickers back to queued.
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

const ANALYSIS: ChunkAnalysis = {
  riskLevel: 'high',
  findings: [
    {
      path: 'src/a.ts',
      startLine: 10,
      endLine: 10,
      severity: 'high',
      rule: 'a-rule',
      message: 'challenge',
    },
  ],
}

const idle = new Set<string>()

/** `chunks` with `a` already reviewed, as a prior round would have left them on screen. */
function reviewed(chunks: Chunk[]): LiveChunk[] {
  return markReady(reconcile(chunks, idle, []), 'a', ANALYSIS)
}

describe('reconcile', () => {
  test('a brand new chunk starts queued, not analysed', () => {
    const [live] = reconcile([chunk('a')], idle, [])
    expect(live).toMatchObject({ key: 'a', status: 'pending', analysis: null })
  })

  test('a chunk a pass has claimed shows as working', () => {
    const [live] = reconcile([chunk('a')], new Set(['a']), [])
    expect(live?.status).toBe('analyzing')
  })

  /** Its file changed elsewhere and is being read again: the last review stays on screen. */
  test('a chunk being re-reviewed shows as working and keeps its review', () => {
    const [live] = reconcile([chunk('a')], new Set(['a']), reviewed([chunk('a')]))
    expect(live).toMatchObject({ status: 'analyzing', analysis: ANALYSIS })
  })

  /** The failure this exists to prevent: a recompute knocking a finished chunk backwards. */
  test('keeps an analysis already on screen across a recompute', () => {
    const previous: LiveChunk[] = [
      {
        key: 'a',
        contentKey: 'a',
        root: ROOT,
        path: 'src/a.ts',
        startLine: 10,
        endLine: 14,
        kind: 'modified',
        status: 'ready',
        analysis: ANALYSIS,
        reason: null,
      },
    ]
    expect(reconcile([chunk('a')], idle, previous)[0]).toMatchObject({
      status: 'ready',
      analysis: ANALYSIS,
    })
  })

  test('a chunk that has gone away is dropped', () => {
    const previous = reconcile([chunk('a'), chunk('b')], idle, [])
    expect(reconcile([chunk('b')], idle, previous).map((c) => c.key)).toEqual(['b'])
  })

  /** A spinner that can never resolve is worse than an honest refusal. */
  test('an unanalysable chunk is skipped with a stated reason, never left spinning', () => {
    const [live] = reconcile([chunk('a', { analyzable: false, kind: 'binary' })], idle, [])
    expect(live?.status).toBe('skipped')
    expect(live?.reason).toBeTruthy()
  })

  test('preserves order, so the list does not reshuffle under the reader', () => {
    const keys = reconcile([chunk('a'), chunk('b'), chunk('c')], idle, []).map((c) => c.key)
    expect(keys).toEqual(['a', 'b', 'c'])
  })

  test('carries the previous path across a rename', () => {
    const [live] = reconcile([chunk('a', { previousPath: 'src/old.ts' })], idle, [])
    expect(live?.previousPath).toBe('src/old.ts')
  })
})

describe('marking progress', () => {
  const queued = reconcile([chunk('a'), chunk('b')], idle, [])

  test('starting one leaves the others alone', () => {
    const next = markAnalyzing(queued, 'a')
    expect(next[0]?.status).toBe('analyzing')
    expect(next[1]?.status).toBe('pending')
  })

  test('finishing one records its analysis', () => {
    const next = markReady(queued, 'a', ANALYSIS)
    expect(next[0]).toMatchObject({ status: 'ready', analysis: ANALYSIS })
  })

  /** A result arriving for a chunk that has since gone must not throw or resurrect it. */
  test('a result for an unknown chunk changes nothing', () => {
    expect(markReady(queued, 'gone', ANALYSIS)).toEqual(queued)
    expect(markAnalyzing(queued, 'gone')).toEqual(queued)
  })

  /** Its file changed elsewhere: being read again, with the last review still on screen. */
  test('a finished chunk being reviewed again shows as working, keeping its review', () => {
    const ready = markReady(queued, 'a', ANALYSIS)
    expect(markAnalyzing(ready, 'a')[0]).toMatchObject({ status: 'analyzing', analysis: ANALYSIS })
  })

  test('never marks a skipped chunk as working', () => {
    const skipped = markSkipped(queued, new Map([['src/a.ts', 'docs']]))
    expect(markAnalyzing(skipped, 'a')[0]?.status).toBe('skipped')
  })
})

/**
 * The risk bar's verdict, applied to what the reader sees.
 *
 * A skipped chunk is visible, diffable and unexamined — which is the honest rendering of a
 * decision not to spend attention on it. The failure this prevents is subtler than a
 * spinner: an item that looks reviewed because a stale claim is still attached to it.
 */
describe('markSkipped', () => {
  const skips = new Map([['src/a.ts', 'matches neverReview']])

  test('marks a queued chunk with the reason nothing will look at it', () => {
    const [live] = markSkipped(reconcile([chunk('a')], idle, []), skips)
    expect(live).toMatchObject({ status: 'skipped', analysis: null, reason: 'matches neverReview' })
  })

  /** The current policy outranks an analysis bought before the rule existed. */
  test('drops an analysis for a file the policy now skips', () => {
    const ready = reviewed([chunk('a')])
    expect(ready[0]?.status).toBe('ready')
    expect(markSkipped(ready, skips)[0]).toMatchObject({ status: 'skipped', analysis: null })
  })

  test('leaves chunks in files the bar says nothing about', () => {
    const chunks = reconcile([chunk('a', { path: 'src/b.ts' })], idle, [])
    expect(markSkipped(chunks, skips)).toEqual(chunks)
  })

  test('is harmless when nothing is skipped', () => {
    const chunks = reconcile([chunk('a')], idle, [])
    expect(markSkipped(chunks, new Map())).toEqual(chunks)
  })
})

/**
 * The one point where a per-root `LiveChunk[]` slice becomes safe to concatenate with every
 * other root's — stamps the cross-root wire identity over the bare content key `reconcile`
 * still produces internally.
 */
describe('toBoardKeys', () => {
  test('replaces .key with the root+content composite, leaving .contentKey the bare original', () => {
    const [live] = reconcile([chunk('a')], idle, [])
    const [stamped] = toBoardKeys([live as LiveChunk])

    expect(stamped?.key).toBe(boardKey(ROOT, 'a'))
    expect(stamped?.contentKey).toBe('a')
  })

  test('two roots with an identical bare key get distinct stamped keys', () => {
    const [fromRepoA] = reconcile([chunk('same-key', { root: '/repo-a' })], idle, [])
    const [fromRepoB] = reconcile([chunk('same-key', { root: '/repo-b' })], idle, [])

    const [stampedA] = toBoardKeys([fromRepoA as LiveChunk])
    const [stampedB] = toBoardKeys([fromRepoB as LiveChunk])

    expect(stampedA?.contentKey).toBe(stampedB?.contentKey)
    expect(stampedA?.key).not.toBe(stampedB?.key)
  })

  test('leaves every other field untouched', () => {
    const [live] = reconcile([chunk('a')], idle, [])
    const [stamped] = toBoardKeys([live as LiveChunk])

    expect(stamped).toMatchObject({ path: 'src/a.ts', root: ROOT, status: 'pending' })
  })
})

/**
 * The file a reader should open first. Only an answer counts: a chunk still waiting on the
 * check has said nothing about risk, and ranking it as "none" would hide it behind a chunk
 * that actually was judged harmless — or ahead of it, which is worse.
 */

/** A failed check is retried, so it is pending — but it says why, so it is not just queued. */
describe('markFailed', () => {
  const failed = new Map([['a', 'no API key']])

  test('puts a chunk whose check failed back to pending, with the reason', () => {
    const [live] = markFailed(reconcile([chunk('a')], new Set(['a']), []), failed)
    expect(live).toMatchObject({ status: 'pending', reason: 'Review failed: no API key' })
  })

  /** Matched on the content key, so it still applies once board keys are stamped on. */
  test('matches after toBoardKeys', () => {
    const [live] = markFailed(toBoardKeys(reconcile([chunk('a')], idle, [])), failed)
    expect(live?.reason).toBe('Review failed: no API key')
  })

  test('leaves a finished analysis alone', () => {
    const [live] = markFailed(reviewed([chunk('a')]), failed)
    expect(live).toMatchObject({ status: 'ready', reason: null })
  })

  /** A failed re-review leaves the last good one showing, rather than a spinner. */
  test('a failed re-review falls back to the review already on screen', () => {
    const rereading = markAnalyzing(reviewed([chunk('a')]), 'a')
    expect(markFailed(rereading, failed)[0]).toMatchObject({
      status: 'ready',
      analysis: ANALYSIS,
      reason: null,
    })
  })
})
