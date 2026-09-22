import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../../src/adapters/git/commands.ts'
import {
  captureTree,
  createGitSnapshotStore,
  EMPTY_TREE,
} from '../../../src/adapters/git/snapshots.ts'

let repo: string

async function write(path: string, content: string): Promise<void> {
  await Bun.write(join(repo, path), content)
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'turnstile-git-'))
  await git(repo, ['init', '-q'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await write('a.txt', 'one\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'initial'])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('captureTree', () => {
  test('captures a modified tracked file', async () => {
    const before = await captureTree(repo)
    await write('a.txt', 'two\n')
    const after = await captureTree(repo)
    expect(after).not.toBe(before)
  })

  test('captures an untracked file', async () => {
    const before = await captureTree(repo)
    await write('new.txt', 'hello\n')
    const after = await captureTree(repo)
    expect(after).not.toBe(before)
  })

  test('excludes gitignored files', async () => {
    await write('.gitignore', 'secret.txt\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'ignore'])

    const before = await captureTree(repo)
    await write('secret.txt', 'do not capture\n')
    const after = await captureTree(repo)
    expect(after).toBe(before)
  })

  test('captures a deletion', async () => {
    const before = await captureTree(repo)
    await rm(join(repo, 'a.txt'))
    const after = await captureTree(repo)
    expect(after).not.toBe(before)
  })

  test('is deterministic for an unchanged tree', async () => {
    expect(await captureTree(repo)).toBe(await captureTree(repo))
  })

  test('works in a repo with no commits yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'turnstile-unborn-'))
    try {
      await git(fresh, ['init', '-q'])
      await Bun.write(join(fresh, 'x.txt'), 'content\n')
      const tree = await captureTree(fresh)
      expect(tree).toMatch(/^[0-9a-f]{40}$/)
      expect(tree).not.toBe(EMPTY_TREE)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  /**
   * This is the load-bearing test of the whole module. The design promises a review
   * tool that never alters the tree it reviews; if a snapshot perturbs the index, HEAD,
   * the stash, or the reflog, that promise is broken and the approach is wrong.
   */
  test('leaves the user visible git state byte-identical', async () => {
    // Set up genuinely dirty state: a staged change, an unstaged change, an untracked
    // file, and a stash entry.
    await write('a.txt', 'staged\n')
    await git(repo, ['add', 'a.txt'])
    await write('b.txt', 'unstaged\n')
    await git(repo, ['add', 'b.txt'])
    await write('b.txt', 'unstaged modified\n')
    await write('c.txt', 'untracked\n')
    await git(repo, ['stash', 'push', '-q', '-m', 'a stash'])
    await write('d.txt', 'more untracked\n')
    await git(repo, ['add', 'd.txt'])

    const snap = async () => ({
      status: (await git(repo, ['status', '--porcelain=v1', '-z'])).stdout,
      head: (await git(repo, ['rev-parse', 'HEAD'])).stdout,
      stash: (await git(repo, ['stash', 'list'])).stdout,
      log: (await git(repo, ['log', '--oneline', '--all'])).stdout,
      reflog: (await git(repo, ['reflog'])).stdout,
      diffCached: (await git(repo, ['diff', '--cached'])).stdout,
    })

    const before = await snap()
    await captureTree(repo)
    await captureTree(repo)
    const after = await snap()

    expect(after).toEqual(before)
  })
})

/**
 * Regression: precompute and the gate both capture the working tree, and once both moved
 * in-process behind the ACP proxy they began to overlap. Sharing one scratch index meant
 * git's `index.lock` collided, the gate threw, and a turn finished with nothing reviewed —
 * the exact fail-open this project exists to prevent, reintroduced by a latency fix.
 */
describe('concurrent captures', () => {
  test('two captures at once both succeed', async () => {
    await Bun.write(join(repo, 'src/app.ts'), 'export const value = 2\n')

    const trees = await Promise.all([captureTree(repo), captureTree(repo)])
    expect(trees[0]).toMatch(/^[0-9a-f]{40}$/)
    expect(trees[0]).toBe(trees[1] as string)
  })

  test('many at once still agree', async () => {
    const trees = await Promise.all(Array.from({ length: 8 }, () => captureTree(repo)))
    expect(new Set(trees).size).toBe(1)
  })

  /** A per-call name would otherwise pile up one file per capture, forever. */
  test('leaves no scratch index behind', async () => {
    await Promise.all([captureTree(repo), captureTree(repo), captureTree(repo)])

    const scratch = join(repo, '.git', 'turnstile')
    const left = (await readdir(scratch).catch(() => [])).filter((name) => name.startsWith('index'))
    expect(left).toEqual([])
  })
})

describe('createGitSnapshotStore', () => {
  const store = (untrackedExcludes: string[] = []) =>
    createGitSnapshotStore({ cwd: repo, excludePrefixes: ['.turnstile'], untrackedExcludes })

  /** The reason a run records its own starting tree: a commit must not move the work out of
   *  view. Both sides are trees, so HEAD moving changes neither of them. */
  test('a commit made after the base was captured still shows in the delta', async () => {
    const snapshots = store()
    const base = await snapshots.capture()
    await write('a.txt', 'committed change\n')
    await git(repo, ['commit', '-qam', 'agent commit'])

    const deltas = await snapshots.delta(base, await snapshots.capture())
    expect(deltas.map((delta) => delta.path)).toEqual(['a.txt'])
  })

  test('untracked build output matching an exclude never reaches a capture', async () => {
    const snapshots = store(['target/', 'node_modules/'])
    const base = await snapshots.capture()
    await write('target/debug/app', 'binary-ish\n')
    await write('node_modules/pkg/index.js', 'module.exports = 1\n')
    await write('src/main.rs', 'fn main() {}\n')

    const deltas = await snapshots.delta(base, await snapshots.capture())
    expect(deltas.map((delta) => delta.path)).toEqual(['src/main.rs'])
  })

  test('an exclude does not hide a file git already tracks', async () => {
    await write('build/keep.txt', 'tracked\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'track build/'])

    const snapshots = store(['build/'])
    const base = await snapshots.capture()
    await write('build/keep.txt', 'changed\n')

    const deltas = await snapshots.delta(base, await snapshots.capture())
    expect(deltas.map((delta) => delta.path)).toEqual(['build/keep.txt'])
  })

  test("keeps honouring the user's own global excludes file", async () => {
    const globalExcludes = join(repo, '..', `global-excludes-${Date.now()}`)
    await Bun.write(globalExcludes, '*.log\n')
    await git(repo, ['config', 'core.excludesFile', globalExcludes])
    try {
      const snapshots = store(['target/'])
      const base = await snapshots.capture()
      await write('debug.log', 'noise\n')
      await write('target/out', 'noise\n')

      expect(await snapshots.delta(base, await snapshots.capture())).toEqual([])
    } finally {
      await rm(globalExcludes, { force: true })
    }
  })

  test("drops Turnstile's own state directory from every delta", async () => {
    const snapshots = store()
    const base = await snapshots.capture()
    await write('.turnstile/state.json', '{}\n')

    expect(await snapshots.delta(base, await snapshots.capture())).toEqual([])
  })

  test('reads a file as it stood in a snapshot, and null where it did not exist', async () => {
    const snapshots = store()
    const base = await snapshots.capture()
    await write('a.txt', 'two\n')
    const next = await snapshots.capture()

    expect(await snapshots.contents(base, 'a.txt')).toBe('one\n')
    expect(await snapshots.contents(next, 'a.txt')).toBe('two\n')
    expect(await snapshots.contents(next, 'missing.txt')).toBeNull()
  })
})
