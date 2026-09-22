import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileAnalysisCache } from '../../src/adapters/fs/cache.ts'
import { baselineRef } from '../../src/adapters/git/baseline.ts'
import { createGitRootRegistry } from '../../src/adapters/git/rootRegistry.ts'
import { review } from '../../src/app/review.ts'
import { STATE_DIR } from '../../src/core/config.ts'
import type {
  FileReviewInput,
  LoadedRules,
  RepoReader,
  Reviewer,
  RootHandle,
  RootRegistry,
  RuleSource,
} from '../../src/core/ports.ts'
import { type Rule, ruleFrom } from '../../src/core/rules.ts'
import type { Finding } from '../../src/core/types.ts'
import { gitIn, tempGitRepo } from '../support/gitRepo.ts'
import { recordingTelemetry } from '../support/telemetry.ts'

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
 * The review, running while the agent is still working.
 *
 * Each changed file is checked against the rules that govern it shortly after it lands. The
 * properties worth holding are that it never throws into the turn, that it never pays twice for
 * the same file under the same rules, that editing a rule re-checks exactly what it governs, and
 * that a file no rule governs costs nothing at all.
 */

let repo: string
/** The one git handle per test — see `beforeEach`. */
let handle: RootHandle

const FINDING: Finding = {
  path: 'src/app.ts',
  startLine: 1,
  endLine: 1,
  severity: 'low',
  rule: 'everywhere',
  message: 'challenge',
}

function counting(): Reviewer & { calls: number; inputs: FileReviewInput[] } {
  const stub = {
    calls: 0,
    inputs: [] as FileReviewInput[],
    reviewFile: async (input: FileReviewInput): Promise<Finding[]> => {
      stub.calls += 1
      stub.inputs.push(input)
      return [{ ...FINDING, path: input.path }]
    },
  }
  return stub
}

const failing: Reviewer = {
  reviewFile: async () => {
    throw new Error('model outage')
  },
}

function rule(path: string, data: Record<string, unknown>): Rule {
  const result = ruleFrom(path, { description: 'd', rule: 'r', ...data })
  if ('error' in result) throw new Error(result.error)
  return result.rule
}

/** A rule governing every file, so the pipeline has something to check by default. */
const EVERYWHERE = rule('everywhere.yaml', { rule: 'Keep it tidy.' })

let ruleSet: LoadedRules = { rules: [EVERYWHERE], context: [], warnings: [] }
const rules: RuleSource = { load: async () => ruleSet }
const reader: RepoReader = {
  read: async () => null,
  glob: async () => ({ paths: [], truncated: false }),
  grep: async () => ({ matches: [], truncated: false }),
}

/** The real git-backed handle for `root`, the one `adapters/git/rootRegistry.ts` builds. */
function gitHandleFor(root: string): RootHandle {
  return createGitRootRegistry({ excludePrefixes: [STATE_DIR], untrackedExcludes: [] }).activate(
    root,
    'sess-1',
  )
}

function depsFor(
  reviewer: Reviewer,
  riskBar: Globs = { alwaysReview: [], neverReview: [], specPaths: [] },
) {
  return {
    roots: singleRootRegistry(handle),
    reviewer,
    cache: createFileAnalysisCache(repo),
    rules,
    reader,
    riskBar,
    concurrency: 3,
  }
}

type Globs = { alwaysReview: string[]; neverReview: string[]; specPaths: string[] }

const run = (reviewer: Reviewer) => review(depsFor(reviewer))

beforeEach(async () => {
  ruleSet = { rules: [EVERYWHERE], context: [], warnings: [] }
  repo = await tempGitRepo('turnstile-review-')
  await Bun.write(join(repo, 'src/app.ts'), 'export const value = 1\n')

  // The session's starting point, recorded the way `Worktrees.ensure` does before the agent acts.
  handle = gitHandleFor(repo)
  const anchor = await handle.snapshots.capture()
  gitIn(repo, 'update-ref', baselineRef('sess-1'), gitIn(repo, 'commit-tree', anchor, '-m', 'b'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('review', () => {
  test('does nothing when nothing has changed', async () => {
    const reviewer = counting()
    expect(await run(reviewer)).toMatchObject({ reviewed: 0, hits: 0 })
    expect(reviewer.calls).toBe(0)
  })

  test('reviews a change and caches it', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    expect((await run(reviewer)).reviewed).toBeGreaterThan(0)
    expect(reviewer.calls).toBeGreaterThan(0)
  })

  /** The whole point: work done once, while the agent was still typing, is not redone. */
  test('a second pass over the same change pays nothing', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await run(counting())

    const second = counting()
    const result = await run(second)

    expect(second.calls).toBe(0)
    expect(result.reviewed).toBe(0)
    expect(result.hits).toBeGreaterThan(0)
  })

  test('reviews only what is new after a further edit', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await run(counting())

    await Bun.write(join(repo, 'src/other.ts'), 'export const other = 1\n')
    const second = counting()
    const result = await run(second)

    expect(result.hits).toBeGreaterThan(0)
    expect(result.reviewed).toBeGreaterThan(0)
  })

  describe('never throws into the turn', () => {
    test('a failing model is swallowed', async () => {
      await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
      const result = await run(failing)
      expect(result.reviewed).toBe(0)
    })

    /** A root whose snapshots fail must degrade to a reported failure, not throw. */
    test('a root whose snapshots fail is reported, not thrown', async () => {
      const result = await review({
        ...depsFor(counting()),
        roots: singleRootRegistry({
          ...handle,
          snapshots: {
            ...handle.snapshots,
            capture: async () => {
              throw new Error('scan failed')
            },
          },
        }),
      })
      expect(result.skipped).not.toBeNull()
      expect(result.skipped).toContain(repo)
    })
  })

  /** The sidebar shows which file is being worked on, not just that something is. */
  test('reports each file as it is reviewed', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const events: string[] = []
    await review({
      ...depsFor(counting()),
      onReviewing: (root, path, chunks) =>
        events.push(`reviewing ${root === repo} ${path} ${chunks.length}`),
      onReviewed: (root, path, _chunks, findings) =>
        events.push(`reviewed ${root === repo} ${path} ${findings.map((f) => f.severity)}`),
    })

    expect(events).toEqual(['reviewing true src/app.ts 1', 'reviewed true src/app.ts low'])
  })

  /** A restarted app shows cached reviews without paying for them again. */
  test('reports a cache hit as reviewed', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await run(counting())

    const reviewed: string[] = []
    await review({
      ...depsFor(counting()),
      onReviewed: (_root, path, _chunks, findings) => reviewed.push(`${path} ${findings.length}`),
    })
    expect(reviewed).toEqual(['src/app.ts 1'])
  })

  test('one review per file, covering all of its chunks', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i}`)
    await Bun.write(join(repo, 'src/big.ts'), `${lines.join('\n')}\n`)
    handle = gitHandleFor(repo)
    const anchor = await handle.snapshots.capture()
    gitIn(repo, 'update-ref', baselineRef('sess-1'), gitIn(repo, 'commit-tree', anchor, '-m', 'b'))

    lines[2] = 'export const v2 = 200'
    lines[55] = 'export const v55 = 5500'
    await Bun.write(join(repo, 'src/big.ts'), `${lines.join('\n')}\n`)

    const reviewer = counting()
    await run(reviewer)
    expect(reviewer.calls).toBe(1)
    expect(reviewer.inputs[0]?.chunks.length).toBe(2)
    expect(reviewer.inputs[0]?.content).toContain('v55 = 5500')
  })

  test('gives the reviewer the rules governing the file, and only those', async () => {
    ruleSet = {
      rules: [
        rule('rules/ts.yaml', { globs: 'src/**/*.ts', rule: 'No default exports.' }),
        rule('rules/py.yaml', { globs: '**/*.py', rule: 'Type hints.' }),
      ],
      context: [],
      warnings: [],
    }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    await review(depsFor(reviewer))

    expect(reviewer.inputs[0]?.rules.map((rule) => rule.name)).toEqual(['ts'])
  })

  /** Background for judging the rules, and the repository itself to go and look in. */
  test('gives the reviewer the context docs above the file and the repository reader', async () => {
    ruleSet = { ...ruleSet, context: [{ path: 'CLAUDE.md', body: 'Be kind.' }] }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    await review(depsFor(reviewer))

    expect(reviewer.inputs[0]?.context.map((doc) => doc.path)).toEqual(['CLAUDE.md'])
    expect(reviewer.inputs[0]?.reader).toBe(reader)
  })

  /** Nothing to check it against is a clean file, not a question worth paying for. */
  test('a file no rule governs is reported clean without a model call', async () => {
    ruleSet = { rules: [rule('rules/py.yaml', { globs: '**/*.py' })], context: [], warnings: [] }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    const telemetry = recordingTelemetry()
    const reviewed: string[] = []
    await review({
      ...depsFor(reviewer),
      telemetry,
      onReviewed: (_root, path, _chunks, findings) => reviewed.push(`${path} ${findings.length}`),
    })

    expect(reviewer.calls).toBe(0)
    expect(reviewed).toEqual(['src/app.ts 0'])
    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'unruled' })).toBe(1)
    expect(telemetry.spansNamed('turnstile.review.file')).toHaveLength(0)
  })

  /** No rules configured at all — the default for a new repository — never reaches the model. */
  test('with no rules at all, nothing is sent to the reviewer', async () => {
    ruleSet = { rules: [], context: [], warnings: [] }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await Bun.write(join(repo, 'src/other.ts'), 'export const other = 1\n')

    const reviewer = counting()
    const reviewed: string[] = []
    await review({
      ...depsFor(reviewer),
      onReviewed: (_root, path, _chunks, findings) => reviewed.push(`${path} ${findings.length}`),
    })

    expect(reviewer.calls).toBe(0)
    expect(reviewed.sort()).toEqual(['src/app.ts 0', 'src/other.ts 0'])
  })

  /** A rule edit takes effect on the next pass — for the files it governs, and no others. */
  test('editing a rule re-reviews exactly the files it governs', async () => {
    const tsRule = (text: string) => rule('rules/ts.yaml', { globs: 'src/**', rule: text })
    ruleSet = { rules: [tsRule('one')], context: [], warnings: [] }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await Bun.write(join(repo, 'lib/other.ts'), 'export const other = 1\n')
    await run(counting())

    ruleSet = { rules: [tsRule('two')], context: [], warnings: [] }
    const second = counting()
    await run(second)
    expect(second.inputs.map((input) => input.path)).toEqual(['src/app.ts'])
  })

  /** Every field of a rule is part of the question or the finding, so every field re-checks. */
  test.each([
    ['severity', { severity: 'high' }],
    ['violates', { violates: 'Any default export.' }],
    ['complies', { complies: 'Named exports only.' }],
    ['description', { description: 'Something else' }],
  ])("changing a rule's %s re-reviews the files it governs", async (_field, change) => {
    ruleSet = { rules: [rule('rules/ts.yaml', {})], context: [], warnings: [] }
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await run(counting())

    ruleSet = { rules: [rule('rules/ts.yaml', change)], context: [], warnings: [] }
    const second = counting()
    await run(second)
    expect(second.calls).toBe(1)
  })

  test('reviews at most `concurrency` files at once', async () => {
    for (let i = 0; i < 6; i++)
      await Bun.write(join(repo, `src/f${i}.ts`), `export const f = ${i}\n`)

    let active = 0
    let peak = 0
    const slow: Reviewer = {
      reviewFile: async () => {
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(10)
        active -= 1
        return []
      },
    }
    await review({ ...depsFor(slow), concurrency: 2 })
    expect(peak).toBe(2)
  })

  /** Reported, so the chunk does not sit on "analyzing" forever. */
  test('reports a failed review', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const failures: string[] = []
    await review({
      ...depsFor(failing),
      onFailed: (_root, _path, _chunks, message) => failures.push(message),
    })

    expect(failures).toEqual(['model outage'])
  })

  /** A crashed pass must not leave a file permanently claimed and never reviewed. */
  test('releases its claim even when the review fails', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await run(failing)

    const retry = counting()
    expect((await run(retry)).reviewed).toBeGreaterThan(0)
  })
})

/**
 * The bar, applied before the money is spent.
 *
 * This is the only place a model's bill is run up, so a file nobody wants checked has to be
 * skipped *here*, not filtered out afterwards.
 */
describe('files beneath the risk bar', () => {
  test('a lockfile is never sent to a model', async () => {
    await Bun.write(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n')

    const reviewer = counting()
    const result = await review(depsFor(reviewer))

    expect(reviewer.calls).toBe(0)
    expect(result.reviewed).toBe(0)
  })

  test('a user neverReview glob is honoured', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    await review(depsFor(reviewer, { alwaysReview: [], neverReview: ['src/**'], specPaths: [] }))

    expect(reviewer.calls).toBe(0)
  })

  /** Skipped is not hidden: the sidebar still lists it, with the reason, immediately. */
  test('the chunk is still announced, carrying why nothing will look at it', async () => {
    await Bun.write(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n')

    const announced: { paths: string[]; skips: Map<string, string> } = {
      paths: [],
      skips: new Map(),
    }
    await review({
      ...depsFor(counting()),
      onChunks: (_root, chunks, skips) => {
        announced.paths = chunks.map((chunk) => chunk.path)
        announced.skips = new Map(skips)
      },
    })

    expect(announced.paths).toEqual(['bun.lock'])
    expect(announced.skips.get('bun.lock')).toContain('generated or vendored')
  })

  test('a source file beside it is still reviewed', async () => {
    await Bun.write(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n')
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const reviewer = counting()
    await review(depsFor(reviewer))

    expect(reviewer.calls).toBe(1)
  })
})

/**
 * What the review pass reports about itself.
 *
 * The review is the part of a session that costs model calls — a request per changed chunk —
 * so it is the part worth being able to see. These assert the measurements exist where the work
 * is, and that taking them never changes the pass's own outcome.
 */
describe('what the review measures', () => {
  test('opens a span for the pass and one per file it actually reviews', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const telemetry = recordingTelemetry()

    await review({ ...depsFor(counting()), telemetry })

    expect(telemetry.spansNamed('turnstile.review.run')).toHaveLength(1)
    const files = telemetry.spansNamed('turnstile.review.file')
    expect(files).toHaveLength(1)
    expect(files[0]?.attrs['turnstile.path']).toBe('src/app.ts')
  })

  test('counts a reviewed file as reviewed', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const telemetry = recordingTelemetry()

    await review({ ...depsFor(counting()), telemetry })

    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'reviewed' })).toBe(1)
  })

  /** A cache hit costs no model call, so it must not look like one that did. */
  test('counts a cached file as cached, and opens no file span for it', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const cache = createFileAnalysisCache(repo)
    await review({ ...depsFor(counting()), cache })

    const telemetry = recordingTelemetry()
    await review({ ...depsFor(counting()), cache, telemetry })

    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'cached' })).toBe(1)
    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'reviewed' })).toBe(0)
    expect(telemetry.spansNamed('turnstile.review.file')).toHaveLength(0)
  })

  test('counts each finding under its severity', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const telemetry = recordingTelemetry()

    await review({ ...depsFor(counting()), telemetry })

    // `counting()` returns one low-severity finding per file.
    expect(telemetry.totalCounted('turnstile.findings', { severity: 'low' })).toBe(1)
  })

  test('counts a failed review as failed and marks its span failed', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const telemetry = recordingTelemetry()

    await review({ ...depsFor(failing), telemetry })

    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'failed' })).toBe(1)
    expect(telemetry.spansNamed('turnstile.review.file')[0]?.failed).toBe(true)
  })

  /** The pass is best-effort and must not start throwing because it is being watched. */
  test('reports the same result whether or not anything is collecting', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const measured = await review({
      ...depsFor(counting()),
      telemetry: recordingTelemetry(),
    })

    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 3\n')
    const plain = await review(depsFor(counting()))

    expect(measured).toEqual(plain)
  })
})

/** How much of a diff is never read at all is worth knowing: it is the blind spot. */
describe('what the review measures about what it skips', () => {
  test('counts a file the risk bar skipped, and never opens a span for it', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    const telemetry = recordingTelemetry()

    await review({
      ...depsFor(counting(), { alwaysReview: [], neverReview: ['src/**'], specPaths: [] }),
      telemetry,
    })

    expect(telemetry.totalCounted('turnstile.review.files', { outcome: 'skipped' })).toBe(1)
    expect(telemetry.spansNamed('turnstile.review.file')).toHaveLength(0)
  })
})
