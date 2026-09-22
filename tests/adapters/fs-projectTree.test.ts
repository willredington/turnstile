import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectTree } from '../../src/adapters/fs/projectTree.ts'

/**
 * The browsable project tree: every file, minus whatever `.gitignore` — at any level — says
 * to skip, and always minus `.git` itself.
 */

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'turnstile-project-tree-'))

  await Bun.write(join(repo, '.gitignore'), 'node_modules\n')
  await Bun.write(join(repo, 'src/a.ts'), 'export const a = 1\n')
  await Bun.write(join(repo, 'src/b.ts'), 'export const b = 2\n')
  await Bun.write(join(repo, 'nested/.gitignore'), 'ignored.txt\n')
  await Bun.write(join(repo, 'nested/keep.ts'), 'export const keep = true\n')
  await Bun.write(join(repo, 'nested/ignored.txt'), 'should not appear\n')
  await Bun.write(join(repo, 'node_modules/pkg/index.js'), 'module.exports = {}\n')
  await mkdir(join(repo, '.git'), { recursive: true })
  await Bun.write(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
  await mkdir(join(repo, 'sub/.git'), { recursive: true })
  await Bun.write(join(repo, 'sub/.git/HEAD'), 'ref: refs/heads/main\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('list', () => {
  test('includes ordinary files and dotfiles alike', async () => {
    const paths = await createProjectTree().list(repo)
    expect(paths).toContain('src/a.ts')
    expect(paths).toContain('src/b.ts')
    expect(paths).toContain('nested/keep.ts')
    expect(paths).toContain('.gitignore')
  })

  test('excludes a file matched by the root .gitignore', async () => {
    const paths = await createProjectTree().list(repo)
    expect(paths).not.toContain('node_modules/pkg/index.js')
  })

  test('excludes a file matched by a nested .gitignore', async () => {
    const paths = await createProjectTree().list(repo)
    expect(paths).not.toContain('nested/ignored.txt')
  })

  test('always excludes .git, gitignore or not', async () => {
    const paths = await createProjectTree().list(repo)
    expect(paths.some((path) => path.startsWith('.git/'))).toBe(false)
  })

  test('excludes a nested .git directory too, not just the root one', async () => {
    const paths = await createProjectTree().list(repo)
    // `sub/.git/HEAD` (set up in beforeEach) is exactly the shape a submodule or a
    // `.claude/worktrees/<name>/.git` looks like — a bare `ignore: ['.git']` pattern only
    // prunes a root-level `.git`, so this only passes with `**/.git`.
    expect(paths.some((path) => path.split('/').includes('.git'))).toBe(false)
  })

  test('does not follow a symlink out of the project root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'turnstile-project-tree-outside-'))
    try {
      await Bun.write(join(outside, 'secret.txt'), 'top secret\n')

      let canSymlink = true
      try {
        await symlink(outside, join(repo, 'escape'), 'dir')
      } catch {
        canSymlink = false
      }
      if (!canSymlink) {
        // Some sandboxed environments can't create symlinks — nothing to assert then, but
        // the intent is to run this for real whenever the environment allows it.
        return
      }

      const paths = await createProjectTree().list(repo)
      expect(paths.some((path) => path.includes('secret.txt'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('read', () => {
  test('reads a real file', async () => {
    expect(await createProjectTree().read(repo, 'src/a.ts')).toEqual({
      kind: 'text',
      text: 'export const a = 1\n',
    })
  })

  test('a binary file reports itself as binary rather than as text', async () => {
    // A PDF, decoded as UTF-8, is a handful of enormous lines that freeze every line-rendering
    // surface in the app — so the read port classifies it instead of handing over the bytes.
    await Bun.write(join(repo, 'doc.pdf'), new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x0a]))
    expect(await createProjectTree().read(repo, 'doc.pdf')).toEqual({ kind: 'binary' })
  })

  test('a text file full of multi-byte characters still reads as text', async () => {
    await Bun.write(join(repo, 'unicode.ts'), 'const greeting = "héllo — 🌍"\n')
    expect(await createProjectTree().read(repo, 'unicode.ts')).toEqual({
      kind: 'text',
      text: 'const greeting = "héllo — 🌍"\n',
    })
  })

  test('a missing file reads as null', async () => {
    expect(await createProjectTree().read(repo, 'src/nope.ts')).toBeNull()
  })

  test('a traversal attempt reads as null', async () => {
    expect(await createProjectTree().read(repo, '../../etc/passwd')).toBeNull()
  })

  test('cannot read through a symlink pointing outside the project root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'turnstile-project-tree-outside-'))
    try {
      await Bun.write(join(outside, 'secret.txt'), 'top secret\n')

      let canSymlink = true
      try {
        await symlink(join(outside, 'secret.txt'), join(repo, 'escape.txt'), 'file')
      } catch {
        canSymlink = false
      }
      if (!canSymlink) return

      expect(await createProjectTree().read(repo, 'escape.txt')).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
