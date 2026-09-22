import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRepoReader,
  MAX_GLOB_PATHS,
  MAX_GREP_MATCHES,
} from '../../src/adapters/fs/repoReader.ts'

/**
 * The reviewer's window on the repository. What matters: it cannot see outside the repository,
 * it sees what the explorer sees, and no query can return an unbounded answer.
 */

let root: string
const reader = createRepoReader()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'turnstile-reader-'))
  await Bun.write(join(root, '.gitignore'), 'dist/\n')
  await Bun.write(join(root, 'src/a.ts'), 'export const a = 1\nexport function run() {}\n')
  await Bun.write(join(root, 'src/b.ts'), 'import { a } from "./a"\n')
  await Bun.write(join(root, 'dist/a.js'), 'export const a = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('read', () => {
  test('reads a file in the repository', async () => {
    expect(await reader.read(root, 'src/b.ts')).toBe('import { a } from "./a"\n')
  })

  test('refuses a path that leaves the repository', async () => {
    expect(await reader.read(root, '../etc/passwd')).toBeNull()
    expect(await reader.read(root, '/etc/passwd')).toBeNull()
  })

  test('refuses a symlink pointing out of it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'turnstile-outside-'))
    try {
      await Bun.write(join(outside, 'secret'), 'secret')
      await symlink(join(outside, 'secret'), join(root, 'src/leak'))
      expect(await reader.read(root, 'src/leak')).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('glob', () => {
  test('lists matching files, gitignore respected', async () => {
    expect(await reader.glob(root, '**/*.{ts,js}')).toEqual({
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: false,
    })
  })

  test('is capped', async () => {
    for (let i = 0; i < MAX_GLOB_PATHS + 5; i++) await Bun.write(join(root, `many/${i}.txt`), '')
    const result = await reader.glob(root, 'many/*')
    expect(result.paths).toHaveLength(MAX_GLOB_PATHS)
    expect(result.truncated).toBe(true)
  })
})

describe('grep', () => {
  test('finds matching lines with their numbers, gitignore respected', async () => {
    expect(await reader.grep(root, 'export const a')).toEqual({
      matches: [{ path: 'src/a.ts', line: 1, text: 'export const a = 1' }],
      truncated: false,
    })
  })

  test('limits the search to a glob', async () => {
    const { matches } = await reader.grep(root, 'a', 'src/b.ts')
    expect(matches.map((match) => match.path)).toEqual(['src/b.ts'])
  })

  test('is capped', async () => {
    await Bun.write(join(root, 'big.txt'), 'hit\n'.repeat(MAX_GREP_MATCHES + 5))
    const result = await reader.grep(root, 'hit')
    expect(result.matches).toHaveLength(MAX_GREP_MATCHES)
    expect(result.truncated).toBe(true)
  })

  test('an invalid pattern is an error the model can read', async () => {
    await expect(reader.grep(root, '(')).rejects.toThrow('Invalid regular expression')
  })
})
