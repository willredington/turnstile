import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInside, resolveInside } from '../../src/adapters/fs/safePath.ts'

/**
 * The one guard every filesystem-touching adapter shares: never resolve a browser-supplied
 * path to somewhere outside the project root.
 */

describe('resolveInside', () => {
  test('joins a relative path onto the root', () => {
    expect(resolveInside('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
  })

  test('a path that walks out and back in is fine', () => {
    expect(resolveInside('/repo', 'src/../src/a.ts')).toBe('/repo/src/a.ts')
  })

  test('the root itself resolves', () => {
    expect(resolveInside('/repo', '.')).toBe('/repo')
  })

  for (const path of ['../escape.ts', '../../escape.ts', 'src/../../escape.ts']) {
    test(`refuses ${path}`, () => {
      expect(resolveInside('/repo', path)).toBeNull()
    })
  }

  test('refuses an absolute path', () => {
    expect(resolveInside('/repo', '/etc/passwd')).toBeNull()
  })

  test('refuses a path containing a null byte', () => {
    expect(resolveInside('/repo', 'src/a.ts\0.png')).toBeNull()
  })

  /** `/repo-evil` merely starts with `/repo` — the check must require the separator too. */
  test('is not fooled by a sibling with a similar name', () => {
    expect(resolveInside('/repo', '../repo-evil/x.ts')).toBeNull()
  })
})

describe('readInside', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'turnstile-safepath-'))
    await Bun.write(join(repo, 'src/a.ts'), 'export const value = 1\n')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  test('reads a real file', async () => {
    expect(await readInside(repo, 'src/a.ts')).toBe('export const value = 1\n')
  })

  test('a missing file reads as null', async () => {
    expect(await readInside(repo, 'src/nope.ts')).toBeNull()
  })

  test('a traversal attempt reads as null', async () => {
    expect(await readInside(repo, '../../etc/passwd')).toBeNull()
  })

  describe('symlinks', () => {
    let outside: string
    let canSymlink = true

    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), 'turnstile-safepath-outside-'))
      await Bun.write(join(outside, 'secret.txt'), 'top secret\n')
    })

    afterEach(async () => {
      await rm(outside, { recursive: true, force: true })
    })

    test('cannot read through a symlinked file pointing outside root', async () => {
      try {
        await symlink(join(outside, 'secret.txt'), join(repo, 'escape.txt'), 'file')
      } catch {
        canSymlink = false
      }
      if (!canSymlink) return

      expect(await readInside(repo, 'escape.txt')).toBeNull()
    })

    test('cannot read through a symlinked directory pointing outside root', async () => {
      try {
        await symlink(outside, join(repo, 'escape-dir'), 'dir')
      } catch {
        canSymlink = false
      }
      if (!canSymlink) return

      expect(await readInside(repo, 'escape-dir/secret.txt')).toBeNull()
    })

    test('a symlink that stays inside root still reads normally', async () => {
      await mkdir(join(repo, 'real'), { recursive: true })
      await Bun.write(join(repo, 'real/inner.ts'), 'export const inner = 1\n')

      try {
        await symlink(join(repo, 'real/inner.ts'), join(repo, 'link.ts'), 'file')
      } catch {
        canSymlink = false
      }
      if (!canSymlink) return

      expect(await readInside(repo, 'link.ts')).toBe('export const inner = 1\n')
    })
  })
})
