import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { baselineRef } from '../../src/adapters/git/baseline.ts'
import { createGitRootRegistry } from '../../src/adapters/git/rootRegistry.ts'
import { MAX_DIFF_CHARS, type ReviewDeps, review } from '../../src/app/review.ts'
import { contentHash } from '../../src/core/annotations.ts'
import { STATE_DIR } from '../../src/core/config.ts'
import type { Reviewer, ReviewInput, RootHandle, RootRegistry } from '../../src/core/ports.ts'
import type { Finding, StoredReview } from '../../src/core/types.ts'
import { gitIn, tempGitRepo } from '../support/gitRepo.ts'

/** A fixed, single-root registry — `review()` only ever calls `knownRoots()`. */
function singleRootRegistry(handle: RootHandle): RootRegistry {
  return {
    knownRoots: () => [handle],
    activate: () => handle,
    deactivate: () => {},
    rootFor: () => handle,
    teardown: async () => {},
  }
}

/**
 * The review: every changed file with no current review, in one run.
 *
 * The properties worth holding are that it reviews exactly the files whose review is missing or
 * stale — never one that is current, never a skipped one — that it hands the reviewer all of them
 * at once, that each review carries the hash its file had when the review STARTED, and that it
 * never throws into the turn.
 */

let repo: string
let handle: RootHandle

const FINDING: Omit<Finding, 'path'> = {
  startLine: 1,
  endLine: 1,
  severity: 'low',
  title: 'Magic number',
  message: 'Say what the 2 is.',
}

function recording(): Reviewer & { inputs: ReviewInput[] } {
  const stub = {
    inputs: [] as ReviewInput[],
    review: async (input: ReviewInput) => {
      stub.inputs.push(input)
      return new Map(input.files.map((file) => [file.path, [{ ...FINDING, path: file.path }]]))
    },
  }
  return stub
}

const failing: Reviewer = {
  review: async () => {
    throw new Error('model outage')
  },
}

/** What the store would say: the hash each file was last reviewed at. */
let reviewed = new Map<string, string>()

function depsFor(reviewer: Reviewer, overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    roots: singleRootRegistry(handle),
    reviewer,
    riskBar: { alwaysReview: [], neverReview: [], specPaths: [] },
    reviewedHash: (_root, path) => reviewed.get(path),
    ...overrides,
  }
}

beforeEach(async () => {
  reviewed = new Map()
  repo = await tempGitRepo('turnstile-review-')
  await Bun.write(join(repo, 'src/app.ts'), 'export const value = 1\n')
  await Bun.write(join(repo, 'src/other.ts'), 'export const other = 1\n')

  // The session's starting point, recorded the way `Repository.open` does before the agent acts.
  handle = createGitRootRegistry({ excludePrefixes: [STATE_DIR], untrackedExcludes: [] }).activate(
    repo,
    'sess-1',
  )
  const anchor = await handle.snapshots.capture()
  gitIn(repo, 'update-ref', baselineRef('sess-1'), gitIn(repo, 'commit-tree', anchor, '-m', 'b'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('review', () => {
  test('does nothing when nothing has changed', async () => {
    const reviewer = recording()
    expect(await review(depsFor(reviewer))).toEqual({ reviewed: 0, skipped: null })
    expect(reviewer.inputs).toHaveLength(0)
  })

  test('reviews every changed file in one run, with their diff', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await Bun.write(join(repo, 'src/new.ts'), 'export const fresh = true\n')
    const reviewer = recording()

    expect(await review(depsFor(reviewer))).toEqual({ reviewed: 2, skipped: null })

    expect(reviewer.inputs).toHaveLength(1)
    const input = reviewer.inputs[0]
    expect(input?.root).toBe(repo)
    expect(input?.files).toEqual([
      { path: 'src/app.ts', kind: 'modified' },
      { path: 'src/new.ts', kind: 'created' },
    ])
    expect(input?.diff).toContain('+export const value = 2')
    expect(input?.diff).toContain('+export const fresh = true')
  })

  test('reports each file’s review with the hash it was reviewed at', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const reported: StoredReview[] = []

    await review(
      depsFor(recording(), { onReviewed: (_root, reviews) => reported.push(...reviews) }),
    )

    expect(reported).toEqual([
      {
        root: repo,
        path: 'src/app.ts',
        fileHash: contentHash('export const value = 2\n'),
        findings: [{ ...FINDING, path: 'src/app.ts' }],
        reviewedAt: expect.any(String),
      },
    ])
  })

  test('leaves a file whose review is current alone', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await Bun.write(join(repo, 'src/other.ts'), 'export const other = 2\n')
    reviewed.set('src/app.ts', contentHash('export const value = 2\n'))
    const reviewer = recording()

    await review(depsFor(reviewer))

    expect(reviewer.inputs[0]?.files.map((file) => file.path)).toEqual(['src/other.ts'])
  })

  test('reviews a file again once it has changed since its review', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 3\n')
    reviewed.set('src/app.ts', contentHash('export const value = 2\n'))
    const reviewer = recording()

    await review(depsFor(reviewer))

    expect(reviewer.inputs[0]?.files.map((file) => file.path)).toEqual(['src/app.ts'])
  })

  test('with every changed file current, nothing is sent to the reviewer', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    reviewed.set('src/app.ts', contentHash('export const value = 2\n'))
    const reviewer = recording()

    expect(await review(depsFor(reviewer))).toEqual({ reviewed: 0, skipped: null })
    expect(reviewer.inputs).toHaveLength(0)
  })

  test('reviews a deleted file', async () => {
    await rm(join(repo, 'src/other.ts'))
    const reviewer = recording()
    const reported: StoredReview[] = []

    await review(depsFor(reviewer, { onReviewed: (_root, reviews) => reported.push(...reviews) }))

    expect(reviewer.inputs[0]?.files).toEqual([{ path: 'src/other.ts', kind: 'deleted' }])
    expect(reported[0]?.fileHash).toBe(contentHash(null))
  })

  test('announces the files it is about to review', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const announced: string[][] = []

    await review(depsFor(recording(), { onReviewing: (_root, paths) => announced.push(paths) }))

    expect(announced).toEqual([['src/app.ts']])
  })

  test('cuts a huge diff short, and says so', async () => {
    await Bun.write(join(repo, 'src/app.ts'), `${'x'.repeat(MAX_DIFF_CHARS + 10)}\n`)
    const reviewer = recording()

    await review(depsFor(reviewer))

    const diff = reviewer.inputs[0]?.diff ?? ''
    expect(diff.length).toBeLessThan(MAX_DIFF_CHARS + 200)
    expect(diff).toContain('The diff is cut short here')
  })

  describe('failure', () => {
    test('a failing reviewer is reported per file, not thrown', async () => {
      await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
      const failures: { paths: string[]; message: string }[] = []

      const result = await review(
        depsFor(failing, {
          onFailed: (_root, paths, message) => failures.push({ paths, message }),
        }),
      )

      expect(result.reviewed).toBe(0)
      expect(failures).toEqual([{ paths: ['src/app.ts'], message: 'model outage' }])
    })

    test('a root whose snapshots fail is reported, not thrown', async () => {
      const result = await review(
        depsFor(recording(), {
          roots: singleRootRegistry({
            ...handle,
            snapshots: {
              ...handle.snapshots,
              capture: async () => {
                throw new Error('scan failed')
              },
            },
          }),
        }),
      )
      expect(result.skipped).toContain(repo)
    })
  })

  describe('skipped files', () => {
    test('a lockfile is never sent to the reviewer', async () => {
      await Bun.write(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n')
      const reviewer = recording()

      expect(await review(depsFor(reviewer))).toEqual({ reviewed: 0, skipped: null })
      expect(reviewer.inputs).toHaveLength(0)
    })

    test('a user neverReview glob is honoured', async () => {
      await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
      const reviewer = recording()

      await review(
        depsFor(reviewer, {
          riskBar: { alwaysReview: [], neverReview: ['src/**'], specPaths: [] },
        }),
      )

      expect(reviewer.inputs).toHaveLength(0)
    })

    test('a source file beside a skipped one is still reviewed, alone', async () => {
      await Bun.write(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n')
      await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
      const reviewer = recording()

      await review(depsFor(reviewer))

      expect(reviewer.inputs[0]?.files.map((file) => file.path)).toEqual(['src/app.ts'])
    })
  })
})
