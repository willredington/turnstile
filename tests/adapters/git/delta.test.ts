import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../../src/adapters/git/commands.ts'
import { computeDelta, patchFor } from '../../../src/adapters/git/delta.ts'
import { captureTree } from '../../../src/adapters/git/snapshots.ts'
import { parseHunks } from '../../../src/core/patch.ts'

let repo: string
let base: string

async function write(path: string, content: string): Promise<void> {
  await Bun.write(join(repo, path), content)
}

const NUMBERED = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'turnstile-delta-'))
  await git(repo, ['init', '-q'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await write('src/app.ts', `${NUMBERED}\n`)
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'initial'])
  base = await captureTree(repo)
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('parsePatch', () => {
  test('reads hunk ranges from new-side line numbers', () => {
    const parsed = parseHunks(
      ['--- a/f.ts', '+++ b/f.ts', '@@ -10,3 +10,4 @@', ' ctx', '+added', ' ctx', ' ctx'].join(
        '\n',
      ),
    )
    expect(parsed.hunks).toEqual([{ startLine: 10, endLine: 13 }])
    expect(parsed.addedLines).toEqual(['added'])
  })

  test('treats a headerless count as a single line', () => {
    const parsed = parseHunks(['@@ -5 +5 @@', '-old', '+new'].join('\n'))
    expect(parsed.hunks).toEqual([{ startLine: 5, endLine: 5 }])
  })

  test('anchors a zero-length new side rather than inverting the range', () => {
    const parsed = parseHunks(['@@ -3,2 +2,0 @@', '-gone', '-also gone'].join('\n'))
    expect(parsed.hunks).toEqual([{ startLine: 2, endLine: 2 }])
  })

  test('does not mistake +++ and --- headers for changed lines', () => {
    const parsed = parseHunks(
      ['--- a/f.ts', '+++ b/f.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n'),
    )
    expect(parsed.addedLines).toEqual(['b'])
    expect(parsed.removedLines).toEqual(['a'])
  })

  test('ignores the no-newline marker', () => {
    const parsed = parseHunks(
      ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n'),
    )
    expect(parsed.addedLines).toEqual(['b'])
    expect(parsed.removedLines).toEqual(['a'])
  })

  test('flags binary patches', () => {
    const parsed = parseHunks('Binary files a/img.png and b/img.png differ')
    expect(parsed.binary).toBe(true)
    expect(parsed.hunks).toEqual([])
  })

  test('collects multiple hunks', () => {
    const parsed = parseHunks(['@@ -1,3 +1,4 @@', '+one', '@@ -10,3 +11,4 @@', '+two'].join('\n'))
    expect(parsed.hunks.length).toBe(2)
    expect(parsed.addedLines).toEqual(['one', 'two'])
  })
})

describe('computeDelta', () => {
  test('is empty when nothing changed', async () => {
    expect(await computeDelta(repo, base, await captureTree(repo))).toEqual([])
  })

  test('reports a modification with hunks and changed lines', async () => {
    await write('src/app.ts', `${NUMBERED.replace('line 5', 'line five')}\n`)
    const delta = await computeDelta(repo, base, await captureTree(repo))

    expect(delta.length).toBe(1)
    expect(delta[0]?.path).toBe('src/app.ts')
    expect(delta[0]?.status).toBe('Modified')
    expect(delta[0]?.addedLines).toEqual(['line five'])
    expect(delta[0]?.removedLines).toEqual(['line 5'])
    expect(delta[0]?.hunks.length).toBe(1)
  })

  test('reports a created file', async () => {
    await write('src/new.ts', 'export const x = 1\n')
    const delta = await computeDelta(repo, base, await captureTree(repo))
    expect(delta.map((d) => [d.path, d.status])).toEqual([['src/new.ts', 'Created']])
  })

  test('reports a dropped file', async () => {
    await rm(join(repo, 'src/app.ts'))
    const delta = await computeDelta(repo, base, await captureTree(repo))
    expect(delta.map((d) => [d.path, d.status])).toEqual([['src/app.ts', 'Dropped']])
  })

  test('detects an exact rename as a single pure-rename entry', async () => {
    await git(repo, ['mv', 'src/app.ts', 'src/renamed.ts'])
    const delta = await computeDelta(repo, base, await captureTree(repo))

    expect(delta.length).toBe(1)
    expect(delta[0]?.path).toBe('src/renamed.ts')
    expect(delta[0]?.previousPath).toBe('src/app.ts')
    expect(delta[0]?.pureRename).toBe(true)
  })

  test('does not call a rename-with-edits pure', async () => {
    await write('src/renamed.ts', `${NUMBERED.replace('line 1', 'CHANGED')}\n`)
    await rm(join(repo, 'src/app.ts'))
    const delta = await computeDelta(repo, base, await captureTree(repo))

    const renamed = delta.find((d) => d.path === 'src/renamed.ts')
    expect(renamed?.pureRename).toBe(false)
  })

  test('handles several files in one batch', async () => {
    await write('src/app.ts', `${NUMBERED.replace('line 2', 'two')}\n`)
    await write('src/added.ts', 'new\n')
    const delta = await computeDelta(repo, base, await captureTree(repo))
    expect(delta.map((d) => d.path).sort()).toEqual(['src/added.ts', 'src/app.ts'])
  })

  test('handles paths with spaces', async () => {
    await write('a file.ts', 'content\n')
    const delta = await computeDelta(repo, base, await captureTree(repo))
    expect(delta.map((d) => d.path)).toEqual(['a file.ts'])
  })

  test('marks a binary change without line content', async () => {
    await Bun.write(join(repo, 'blob.bin'), new Uint8Array([0, 1, 2, 0, 255]))
    const delta = await computeDelta(repo, base, await captureTree(repo))

    const blob = delta.find((d) => d.path === 'blob.bin')
    expect(blob?.binary).toBe(true)
    expect(blob?.addedLines).toEqual([])
  })
})

describe('gitlink handling', () => {
  async function initNested(nested: string): Promise<void> {
    await git(nested, ['init', '-q'])
    await git(nested, ['config', 'user.email', 'test@example.com'])
    await git(nested, ['config', 'user.name', 'Test'])
  }

  test('excludes an undiscovered nested repo entirely, never surfacing the boundary path', async () => {
    const nested = join(repo, 'embedded')
    await Bun.$`mkdir -p ${nested}`.quiet()
    await initNested(nested)
    await Bun.write(join(nested, 'file.txt'), 'hello\n')
    await git(nested, ['add', '-A'])
    await git(nested, ['commit', '-q', '-m', 'nested commit'])

    const delta = await computeDelta(repo, base, await captureTree(repo))
    expect(delta.some((entry) => entry.path === 'embedded')).toBe(false)
    expect(delta.some((entry) => entry.path.startsWith('embedded/'))).toBe(false)
  })

  test('a file that was ordinary and then became hidden behind a new gitlink shows as dropped, not as the boundary path', async () => {
    const nested = join(repo, 'embedded')
    await Bun.$`mkdir -p ${nested}`.quiet()
    await Bun.write(join(nested, 'file.txt'), 'hello\n')
    // First capture: embedded/file.txt is an ordinary tracked file — no .git there yet, so
    // this is exactly what a root that never discovered `embedded` as its own root sees.
    const withPlainFile = await captureTree(repo)
    const before = await computeDelta(repo, base, withPlainFile)
    expect(before.map((entry) => entry.path)).toEqual(['embedded/file.txt'])

    // Now it becomes a real nested repo, same as an agent running a scaffolding tool that
    // inits git after writing files.
    await initNested(nested)
    await git(nested, ['add', '-A'])
    await git(nested, ['commit', '-q', '-m', 'nested commit'])
    const withGitlink = await captureTree(repo)

    // From the PARENT's own perspective, the blob that used to be at this path is simply
    // gone — a plain tree diff can't tell "became a gitlink" from "was deleted" on its own.
    // This is exactly the case `isPathBehindGitlink` exists to catch downstream.
    const after = await computeDelta(repo, withPlainFile, withGitlink)
    expect(after.map((entry) => [entry.path, entry.status])).toEqual([
      ['embedded/file.txt', 'Dropped'],
    ])
  })
})

describe('patchFor', () => {
  test('returns patch text for one file', async () => {
    await write('src/app.ts', `${NUMBERED.replace('line 5', 'line five')}\n`)
    const patch = await patchFor(repo, base, await captureTree(repo), 'src/app.ts')

    expect(patch).toContain('@@')
    expect(patch).toContain('+line five')
    expect(patch).toContain('-line 5')
  })

  test('follows a rename across both paths', async () => {
    await git(repo, ['mv', 'src/app.ts', 'src/renamed.ts'])
    const patch = await patchFor(
      repo,
      base,
      await captureTree(repo),
      'src/renamed.ts',
      'src/app.ts',
    )
    expect(patch).toContain('rename')
  })

  test('degrades rather than throwing for an unknown path', async () => {
    const patch = await patchFor(repo, base, await captureTree(repo), 'does/not/exist.ts')
    expect(patch).toBe('')
  })
})
