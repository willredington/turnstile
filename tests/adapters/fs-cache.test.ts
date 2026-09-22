import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileAnalysisCache } from '../../src/adapters/fs/cache.ts'
import type { FileReview } from '../../src/core/types.ts'

/**
 * The cache is a latency optimisation, never a source of truth. Every failure mode here
 * must degrade to "analyze it now", because the alternative — surfacing a broken or stale
 * entry as an adjudication — shows the human analysis that does not match the code.
 */

let dir: string
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ANALYSIS: FileReview = {
  findings: [
    {
      path: 'src/a.ts',
      startLine: 3,
      endLine: 4,
      severity: 'high',
      rule: 'async-callers',
      message: 'the caller is still synchronous',
    },
  ],
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turnstile-cache-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('get and put', () => {
  test('misses on an unknown key', async () => {
    expect(await createFileAnalysisCache(dir).get(KEY)).toBeNull()
  })

  test('round-trips an analysis', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.put(KEY, ANALYSIS)
    expect(await cache.get(KEY)).toEqual(ANALYSIS)
  })

  test('is visible to a separately constructed cache over the same directory', async () => {
    await createFileAnalysisCache(dir).put(KEY, ANALYSIS)
    expect(await createFileAnalysisCache(dir).get(KEY)).toEqual(ANALYSIS)
  })

  /** A truncated or hand-edited entry must not surface as an adjudication. */
  test('treats a malformed entry as a miss', async () => {
    await Bun.write(join(dir, '.turnstile/cache', `${KEY}.json`), '{ "riskReason": "only half"')
    expect(await createFileAnalysisCache(dir).get(KEY)).toBeNull()
  })

  /** Including one left behind by the per-chunk risk check the review replaced. */
  test('treats a structurally wrong entry as a miss', async () => {
    await Bun.write(
      join(dir, '.turnstile/cache', `${KEY}.json`),
      JSON.stringify({ riskReason: 'old', riskLevel: 'low' }),
    )
    expect(await createFileAnalysisCache(dir).get(KEY)).toBeNull()
  })

  /** Keys are hex digests; anything else must never reach a filesystem path. */
  test('refuses a key that is not a plain digest', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.put('../../etc/passwd', ANALYSIS)
    expect(await cache.get('../../etc/passwd')).toBeNull()
  })
})

describe('claim', () => {
  test('the first caller wins', async () => {
    const cache = createFileAnalysisCache(dir)
    expect(await cache.claim(KEY)).toBe(true)
  })

  /** Rapid edits must not stack duplicate workers on one chunk. */
  test('a second caller is turned away', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.claim(KEY)
    expect(await cache.claim(KEY)).toBe(false)
  })

  test('releasing lets the next caller through', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.claim(KEY)
    await cache.release(KEY)
    expect(await cache.claim(KEY)).toBe(true)
  })

  test('releasing an unclaimed key is harmless', async () => {
    await createFileAnalysisCache(dir).release(KEY)
    expect(await createFileAnalysisCache(dir).claim(KEY)).toBe(true)
  })

  /** A crashed worker must not wedge a chunk permanently unanalyzable. */
  test('an abandoned claim is taken over once it goes stale', async () => {
    const cache = createFileAnalysisCache(dir)
    const claimFile = join(dir, '.turnstile/cache', `${KEY}.claim`)
    await Bun.write(claimFile, 'stale')

    // Backdate past the staleness cutoff.
    const old = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(claimFile, old, old)

    expect(await cache.claim(KEY)).toBe(true)
  })

  test('a fresh claim from another worker is respected', async () => {
    const cache = createFileAnalysisCache(dir)
    await Bun.write(join(dir, '.turnstile/cache', `${KEY}.claim`), String(Date.now()))
    expect(await cache.claim(KEY)).toBe(false)
  })
})

describe('prune', () => {
  const OTHER = 'ffffffffffffffffffffffffffffffff'

  test('keeps what is still in play', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.put(KEY, ANALYSIS)
    await cache.prune([KEY])
    expect(await cache.get(KEY)).toEqual(ANALYSIS)
  })

  /** Reverted work would otherwise accumulate in the cache forever. */
  test('drops what is no longer in play', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.put(KEY, ANALYSIS)
    await cache.put(OTHER, ANALYSIS)
    await cache.prune([KEY])

    expect(await cache.get(KEY)).toEqual(ANALYSIS)
    expect(await cache.get(OTHER)).toBeNull()
  })

  test('is harmless when no cache exists yet', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'turnstile-cache-empty-'))
    try {
      await createFileAnalysisCache(empty).prune([KEY])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('also clears abandoned claims', async () => {
    const cache = createFileAnalysisCache(dir)
    await cache.claim(OTHER)
    await cache.prune([KEY])
    expect(await cache.claim(OTHER)).toBe(true)
  })
})
