import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baselineRef } from '../../../src/adapters/git/baseline.ts'
import { createGitRepository } from '../../../src/adapters/git/repository.ts'
import { captureTree } from '../../../src/adapters/git/snapshots.ts'
import { gitIn, tempGitRepo } from '../../support/gitRepo.ts'

let repo: string

beforeEach(async () => {
  repo = await tempGitRepo('turnstile-repository-')
  await Bun.write(join(repo, 'src/app.ts'), 'export const value = 1\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'initial')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const repositoryIn = (dir: string) =>
  createGitRepository({ dir, untrackedExcludes: ['target/', 'node_modules/'] })

/** The tree a session's recorded baseline points at, or null when none is recorded. */
const baselineTree = (sessionId: string, cwd = repo): string | null => {
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--verify', '--quiet', `${baselineRef(sessionId)}^{tree}`],
    { cwd, stdout: 'pipe' },
  )
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

/** Paths in `tree`, recursively. */
const pathsIn = (tree: string, cwd = repo): string[] =>
  gitIn(cwd, 'ls-tree', '-r', '--name-only', tree)
    .split('\n')
    .filter((line) => line !== '')

describe('status', () => {
  test('is git for a repository with commits', async () => {
    expect(await repositoryIn(repo).status()).toBe('git')
  })

  test('is git for a repository with no commits yet', async () => {
    const fresh = await tempGitRepo('turnstile-unborn-')
    try {
      expect(await repositoryIn(fresh).status()).toBe('git')
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  test('is not-git outside any repository', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'turnstile-plain-')))
    try {
      expect(await repositoryIn(plain).status()).toBe('not-git')
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})

describe('init', () => {
  test('makes a plain directory a repository with a first commit, leaving build output out', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'turnstile-plain-')))
    try {
      await Bun.write(join(plain, 'Cargo.toml'), '[package]\nname = "demo"\n')
      await Bun.write(join(plain, 'target/debug/demo'), 'binary\n')
      await Bun.write(join(plain, '.turnstile/config.json'), '{}\n')
      const repository = repositoryIn(plain)

      await repository.init()

      expect(await repository.status()).toBe('git')
      expect(gitIn(plain, 'ls-files').split('\n')).toEqual(['Cargo.toml'])
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})

describe('open', () => {
  test('works in the checkout itself: no worktree, no branch', async () => {
    const opened = await repositoryIn(repo).open('sess-1')

    expect(opened).toEqual({ root: repo, cwd: repo })
    expect(gitIn(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(gitIn(repo, 'branch', '--format=%(refname:short)')).not.toContain('turnstile/')
  })

  test('runs the agent in the subdirectory Turnstile was launched in', async () => {
    await mkdir(join(repo, 'src'), { recursive: true })
    expect(await repositoryIn(join(repo, 'src')).open('sess-1')).toEqual({
      root: repo,
      cwd: join(repo, 'src'),
    })
  })

  test("records the checkout's tree, uncommitted and untracked work included", async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await Bun.write(join(repo, 'notes.txt'), 'draft\n')
    await Bun.write(join(repo, 'node_modules/dep/index.js'), 'module.exports = 1\n')

    await repositoryIn(repo).open('sess-1')

    const recorded = baselineTree('sess-1')
    expect(recorded).not.toBeNull()
    expect(recorded).not.toBe(gitIn(repo, 'rev-parse', 'HEAD^{tree}'))
    // Build output stays out, the same as it does from every capture.
    expect(pathsIn(recorded ?? '')).toEqual(['notes.txt', 'src/app.ts'])
    expect(gitIn(repo, 'show', `${recorded}:src/app.ts`)).toBe('export const value = 2')
  })

  test("leaves the user's index, HEAD and branches alone", async () => {
    await Bun.write(join(repo, 'notes.txt'), 'draft\n')
    const head = gitIn(repo, 'rev-parse', 'HEAD')

    await repositoryIn(repo).open('sess-1')

    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(gitIn(repo, 'status', '--porcelain')).toBe('?? notes.txt')
    expect(gitIn(repo, 'branch', '--format=%(refname:short)')).toBe(
      gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    )
  })

  test("keeps Turnstile's own state out of the user's git status", async () => {
    await Bun.write(join(repo, '.turnstile/annotations.json'), '{}\n')

    await repositoryIn(repo).open('sess-1')

    expect(gitIn(repo, 'status', '--porcelain')).toBe('')
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.turnstile/')
  })

  /** A resumed session is measured from where it first started, not from wherever the checkout
   *  has got to since. */
  test('keeps the baseline it already had', async () => {
    const repository = repositoryIn(repo)
    await repository.open('sess-1')
    const recorded = baselineTree('sess-1')

    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')
    await repository.open('sess-1')

    expect(baselineTree('sess-1')).toBe(recorded)
  })

  test('records a baseline in a repository with no commits', async () => {
    const fresh = await tempGitRepo('turnstile-unborn-')
    try {
      await Bun.write(join(fresh, 'a.txt'), 'one\n')

      await repositoryIn(fresh).open('sess-1')

      const recorded = baselineTree('sess-1', fresh)
      expect(recorded).toBe(await captureTree(fresh))
      expect(pathsIn(recorded ?? '', fresh)).toEqual(['a.txt'])
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('sessionIds', () => {
  test('lists every session with a recorded baseline', async () => {
    const repository = repositoryIn(repo)
    expect(await repository.sessionIds()).toEqual([])

    await repository.open('sess-1')
    await repository.open('sess-2')

    expect((await repository.sessionIds()).sort()).toEqual(['sess-1', 'sess-2'])
  })
})
