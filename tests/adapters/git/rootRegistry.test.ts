import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { baselineRef } from '../../../src/adapters/git/baseline.ts'
import { createGitRootRegistry } from '../../../src/adapters/git/rootRegistry.ts'
import { captureTree } from '../../../src/adapters/git/snapshots.ts'
import { gitIn, tempGitRepo } from '../../support/gitRepo.ts'

const registry = () => createGitRootRegistry({ excludePrefixes: [], untrackedExcludes: [] })

describe('createGitRootRegistry', () => {
  test('knows no root until one is activated', () => {
    const roots = registry()
    expect(roots.knownRoots()).toEqual([])
    expect(roots.rootFor('/repo/a.ts')).toBeNull()
  })

  test('holds exactly the active root, and a new activation replaces it', () => {
    const roots = registry()
    const first = roots.activate('/repo/.turnstile/worktrees/sess-1', 'sess-1')
    expect(roots.knownRoots()).toEqual([first])

    const second = roots.activate('/repo/.turnstile/worktrees/sess-2', 'sess-2')
    expect(roots.knownRoots()).toEqual([second])
  })

  test('re-activating the same root keeps its handle', () => {
    const roots = registry()
    expect(roots.activate('/w', 'sess-1')).toBe(roots.activate('/w', 'sess-1'))
  })

  test('answers only for paths inside the active root', () => {
    const roots = registry()
    const handle = roots.activate('/repo/wt', 'sess-1')

    expect(roots.rootFor('/repo/wt')).toBe(handle)
    expect(roots.rootFor('/repo/wt/src/a.ts')).toBe(handle)
    expect(roots.rootFor('/repo/wt-sibling/a.ts')).toBeNull()
    expect(roots.rootFor('/repo/a.ts')).toBeNull()
  })

  test('teardown forgets the active root', async () => {
    const roots = registry()
    roots.activate('/w', 'sess-1')
    await roots.teardown()
    expect(roots.knownRoots()).toEqual([])
  })

  /** The handle's baseline is found by the session id it was activated with. */
  test("the active root's baseline is its session's recorded start", async () => {
    const repo = await tempGitRepo('turnstile-registry-')
    try {
      await Bun.write(join(repo, 'a.txt'), 'one\n')
      gitIn(repo, 'add', '-A')
      gitIn(repo, 'commit', '-q', '-m', 'init')
      const start = await captureTree(repo)
      gitIn(repo, 'update-ref', baselineRef('sess-1'), gitIn(repo, 'commit-tree', start, '-m', 'b'))

      const handle = registry().activate(repo, 'sess-1')
      expect(await handle.baseline.resolve()).toMatchObject({
        tree: start,
        source: 'session-start',
      })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
