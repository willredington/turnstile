import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findUpward, resolveExecutable } from '../../../src/adapters/agent-sdk/resolveExecutable.ts'

/**
 * `findUpward` is what makes the compiled-binary fallback testable at all: the bug it defends
 * against only appears once `bun build --compile` makes `import.meta.url`/`process.execPath`
 * resolve to a place with no real `node_modules` beside it — nothing short of an actual
 * compile can fake that — but the directory-walking logic that takes over is ordinary and
 * worth testing on its own, same precedent as the ACP-era `defaultCommand`'s own helper.
 */
describe('findUpward', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'turnstile-findupward-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('finds a file several directories above the start point', async () => {
    await mkdir(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
      '',
    )

    const start = join(root, 'desktop/src-tauri/binaries')
    await mkdir(start, { recursive: true })

    const found = findUpward(
      start,
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    )
    expect(found).toBe(
      join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
    )
  })

  test('finds a file in the start directory itself', async () => {
    await writeFile(join(root, 'marker.txt'), '')
    expect(findUpward(root, 'marker.txt')).toBe(join(root, 'marker.txt'))
  })

  test('returns null when nothing is found before the filesystem root', async () => {
    const start = join(root, 'a/b/c')
    await mkdir(start, { recursive: true })
    expect(findUpward(start, 'this-does-not-exist-anywhere.js')).toBeNull()
  })
})

describe('resolveExecutable', () => {
  const original = process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE

  beforeEach(() => {
    delete process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE
    } else {
      process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE = original
    }
  })

  test('TURNSTILE_CLAUDE_CODE_EXECUTABLE override is passed straight through', () => {
    process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE = '/usr/local/bin/claude'
    expect(resolveExecutable()).toBe('/usr/local/bin/claude')
  })

  test("with no override, running interpreted (as tests do), defers to the SDK's own resolution", () => {
    // Interpreted mode has a real node_modules beside this file, so the SDK's own
    // optional-dependency resolution is expected to work unassisted — no override needed.
    expect(resolveExecutable()).toBeUndefined()
  })
})
