import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileEditTarget } from '../../src/adapters/fs/editTarget.ts'

/**
 * The one place Turnstile writes to the tree it is reviewing.
 *
 * Traversal-guard coverage lives in `fs-safePath.test.ts` now that the guard is shared with
 * `projectTree.ts` — this file only checks that this adapter is wired to it correctly.
 */

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'turnstile-edit-target-'))
  await Bun.write(join(repo, 'src/a.ts'), 'export const value = 1\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

test('round-trips a file', async () => {
  const editTarget = createFileEditTarget()
  await editTarget.write(repo, 'src/a.ts', 'export const value = 2\n')

  expect(await editTarget.read(repo, 'src/a.ts')).toBe('export const value = 2\n')
})

test('creates a file that was not there', async () => {
  const editTarget = createFileEditTarget()
  await editTarget.write(repo, 'src/new.ts', 'fresh\n')

  expect(await editTarget.read(repo, 'src/new.ts')).toBe('fresh\n')
})

test('a missing file reads as null rather than throwing', async () => {
  expect(await createFileEditTarget().read(repo, 'src/nope.ts')).toBeNull()
})

test('refuses to write outside the repository', async () => {
  const editTarget = createFileEditTarget()
  expect(editTarget.write(repo, '../escape.ts', 'nope')).rejects.toThrow(/outside the root/)
})
