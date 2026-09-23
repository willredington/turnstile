import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoModePath, createFileAutoModeStore } from '../../../src/adapters/fs/autoMode.ts'
import type { AutoModePolicy } from '../../../src/core/autoMode.ts'

const policy: AutoModePolicy = {
  version: 1,
  threshold: 0.3,
  rules: [{ id: 'push', text: 'Pushes to a remote' }],
}

describe('createFileAutoModeStore', () => {
  test('none until one is saved; then the same policy back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'turnstile-automode-'))
    const store = createFileAutoModeStore(home)
    expect(await store.load()).toBeNull()
    await store.save(policy)
    expect(await store.load()).toEqual(policy)
    expect(await Bun.file(autoModePath(home)).json()).toEqual(policy)
  })

  test('a file that is not a policy reads as none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'turnstile-automode-'))
    const store = createFileAutoModeStore(home)
    await store.save(policy)
    await writeFile(autoModePath(home), '{"rules": 3}')
    expect(await store.load()).toBeNull()
    await writeFile(autoModePath(home), 'not json')
    expect(await store.load()).toBeNull()
  })
})
