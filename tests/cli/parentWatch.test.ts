import { describe, expect, test } from 'bun:test'
import { watchParent } from '../../src/cli/parentWatch.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

describe('watchParent', () => {
  test('calls onGone once the process is reparented', async () => {
    let ppid = 4242
    let gone = 0
    const stop = watchParent(() => gone++, { ppid: () => ppid, intervalMs: 1 })

    await tick()
    expect(gone).toBe(0)

    ppid = 1
    await tick()
    expect(gone).toBe(1)

    // Only once, however long the process takes to actually exit.
    await tick()
    expect(gone).toBe(1)
    stop()
  })

  test('calls nothing after it is stopped', async () => {
    let ppid = 4242
    let gone = 0
    const stop = watchParent(() => gone++, { ppid: () => ppid, intervalMs: 1 })
    stop()

    ppid = 1
    await tick()
    expect(gone).toBe(0)
  })
})
