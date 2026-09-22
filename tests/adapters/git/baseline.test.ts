import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  baselineRef,
  createGitBaseline,
  currentBranch,
} from '../../../src/adapters/git/baseline.ts'
import { captureTree, EMPTY_TREE, headTree } from '../../../src/adapters/git/snapshots.ts'
import { gitIn, tempGitRepo } from '../../support/gitRepo.ts'

let repo: string

const SESSION = 'sess-1'
const BRANCH = `turnstile/${SESSION}`

beforeEach(async () => {
  repo = await tempGitRepo('turnstile-baseline-')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function commitFile(path: string, content: string): Promise<void> {
  await Bun.write(join(repo, path), content)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', `write ${path}`)
}

/** Record `tree` as the session's starting point, the way `Repository.open` does. */
function recordBaseline(tree: string): void {
  const commit = gitIn(repo, 'commit-tree', tree, '-m', 'baseline')
  gitIn(repo, 'update-ref', baselineRef(SESSION), commit)
}

const baseline = () => createGitBaseline({ cwd: repo, sessionId: SESSION })

/** Paths that differ between two trees. */
const changedPaths = (from: string, to: string): string[] =>
  gitIn(repo, 'diff-tree', '-r', '--name-only', from, to)
    .split('\n')
    .filter((line) => line !== '')

describe('baselineRef', () => {
  test('is namespaced per session, outside refs/heads', () => {
    expect(baselineRef('abc')).toBe('refs/turnstile/baselines/abc')
  })
})

describe('createGitBaseline', () => {
  test("prefers the session's recorded starting tree", async () => {
    await commitFile('a.txt', 'one\n')
    gitIn(repo, 'checkout', '-q', '-b', BRANCH)
    // Uncommitted before the session started: in the recorded tree, so it is never on the board.
    await Bun.write(join(repo, 'wip.txt'), 'in progress\n')
    const start = await captureTree(repo)
    recordBaseline(start)

    expect(await baseline().resolve()).toMatchObject({ tree: start, source: 'session-start' })
  })

  /** An agent committing its work moves HEAD, but not the tree the board measures from — so
   *  the committed change stays on the board rather than vanishing into history. */
  test('an agent commit after the baseline keeps the committed change visible', async () => {
    await commitFile('a.txt', 'one\n')
    gitIn(repo, 'checkout', '-q', '-b', BRANCH)
    const start = await captureTree(repo)
    recordBaseline(start)

    await commitFile('a.txt', 'two\n')

    const resolution = await baseline().resolve()
    expect(resolution.tree).toBe(start)
    expect(resolution.tree).not.toBe(await headTree(repo))
    expect(changedPaths(resolution.tree, await captureTree(repo))).toEqual(['a.txt'])
  })

  test("falls back to HEAD's tree with no baseline recorded", async () => {
    await commitFile('a.txt', 'one\n')

    const resolution = await baseline().resolve()
    expect(resolution).toMatchObject({ tree: await headTree(repo), source: 'head' })
  })

  test('is the empty tree in a repository with no commits', async () => {
    expect(await baseline().resolve()).toMatchObject({ tree: EMPTY_TREE, source: 'empty' })
  })

  /** The recorded ref is per session: another session's baseline is never picked up. */
  test("ignores another session's recorded baseline", async () => {
    await commitFile('a.txt', 'one\n')
    const commit = gitIn(repo, 'commit-tree', EMPTY_TREE, '-m', 'other')
    gitIn(repo, 'update-ref', baselineRef('sess-2'), commit)

    expect((await baseline().resolve()).source).toBe('head')
  })

  test('reports the checked-out branch', async () => {
    await commitFile('a.txt', 'one\n')
    gitIn(repo, 'checkout', '-q', '-b', BRANCH)

    expect((await baseline().resolve()).branch).toBe(BRANCH)
  })
})

describe('currentBranch', () => {
  test('is null on a detached HEAD', async () => {
    await commitFile('a.txt', 'one\n')
    gitIn(repo, 'checkout', '-q', '--detach')

    expect(await currentBranch(repo)).toBeNull()
  })
})
