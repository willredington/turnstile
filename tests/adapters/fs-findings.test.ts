import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileFindingStore, findingsPath } from '../../src/adapters/fs/findings.ts'
import type { StoredReview } from '../../src/core/types.ts'

/** File reviews, in `.turnstile/findings.json`, scoped to the session they were made in. */

let dir: string

const SESSION = 'sess-1'
const OTHER_SESSION = 'sess-2'

function review(overrides: Partial<StoredReview> = {}): StoredReview {
  return {
    root: '/repo',
    path: 'src/orders.ts',
    fileHash: 'abc',
    findings: [
      {
        path: 'src/orders.ts',
        startLine: 3,
        endLine: 4,
        severity: 'medium',
        title: 'Unchecked total',
        message: 'A negative total is accepted.',
      },
    ],
    reviewedAt: '2026-09-23T12:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turnstile-findings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('finding store', () => {
  test('nothing is reviewed before anything is written', async () => {
    expect(await createFileFindingStore(dir).bySession(SESSION)).toEqual([])
  })

  test('stores and lists a session’s reviews', async () => {
    const store = createFileFindingStore(dir)
    await store.put(SESSION, [review(), review({ path: 'src/b.ts', findings: [] })])
    expect(await store.bySession(SESSION)).toEqual([
      review(),
      review({ path: 'src/b.ts', findings: [] }),
    ])
  })

  test('reviewing a file again replaces its entry and leaves the rest', async () => {
    const store = createFileFindingStore(dir)
    await store.put(SESSION, [review({ fileHash: 'old' }), review({ path: 'src/b.ts' })])
    await store.put(SESSION, [review({ fileHash: 'new' })])
    expect(await store.bySession(SESSION)).toEqual([
      review({ path: 'src/b.ts' }),
      review({ fileHash: 'new' }),
    ])
  })

  test('sessions are kept apart', async () => {
    const store = createFileFindingStore(dir)
    await store.put(SESSION, [review()])
    await store.put(OTHER_SESSION, [review({ fileHash: 'theirs' })])
    expect(await store.bySession(SESSION)).toEqual([review()])
    expect(await store.bySession(OTHER_SESSION)).toEqual([review({ fileHash: 'theirs' })])
  })

  test('an unreadable file reads as nothing reviewed', async () => {
    await Bun.write(findingsPath(dir), 'not json')
    expect(await createFileFindingStore(dir).bySession(SESSION)).toEqual([])
  })
})
