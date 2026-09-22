import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileHiddenStore, hiddenPath } from '../../src/adapters/fs/hidden.ts'
import type { HiddenFile } from '../../src/core/types.ts'

/** Hidden changed files, in `.turnstile/hidden.json`, scoped to the session that hid them. */

let dir: string

const SESSION = 'sess-1'
const OTHER_SESSION = 'sess-2'

function entry(overrides: Partial<HiddenFile> = {}): HiddenFile {
  return {
    sessionId: SESSION,
    root: '/repo',
    path: 'src/orders.ts',
    fileHash: 'abc',
    at: '2026-09-18T12:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turnstile-hidden-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('hidden files store', () => {
  test('nothing is hidden before anything is written', async () => {
    expect(await createFileHiddenStore(dir).bySession(SESSION)).toEqual([])
  })

  test('hides, lists and shows again', async () => {
    const store = createFileHiddenStore(dir)
    await store.hide(entry())
    expect(await store.bySession(SESSION)).toEqual([entry()])

    await store.show(SESSION, '/repo', 'src/orders.ts')
    expect(await store.bySession(SESSION)).toEqual([])
  })

  test('hiding a file again replaces its entry', async () => {
    const store = createFileHiddenStore(dir)
    await store.hide(entry({ fileHash: 'old' }))
    await store.hide(entry({ fileHash: 'new' }))
    expect(await store.bySession(SESSION)).toEqual([entry({ fileHash: 'new' })])
  })

  test('reads and writes stay within their session', async () => {
    const store = createFileHiddenStore(dir)
    await store.hide(entry())
    await store.hide(entry({ sessionId: OTHER_SESSION }))

    await store.show(OTHER_SESSION, '/repo', 'src/orders.ts')
    expect(await store.bySession(SESSION)).toEqual([entry()])
    expect(await store.bySession(OTHER_SESSION)).toEqual([])
  })

  test('entries it does not recognise are carried over untouched', async () => {
    const stranger = { kind: 'from-a-later-version' }
    await Bun.write(hiddenPath(dir), JSON.stringify({ hidden: [stranger] }))
    const store = createFileHiddenStore(dir)
    await store.hide(entry())

    const raw = (await Bun.file(hiddenPath(dir)).json()) as { hidden: unknown[] }
    expect(raw.hidden).toEqual([stranger, entry()])
  })

  test('a corrupt file reads as nothing hidden', async () => {
    await Bun.write(hiddenPath(dir), '{not json')
    expect(await createFileHiddenStore(dir).bySession(SESSION)).toEqual([])
  })
})
