import { describe, expect, test } from 'bun:test'
import { coalesce } from '../../src/app/coalesce.ts'

/**
 * The background-job runner behind the board rebuild, the review pass and the note sweep.
 *
 * The rule it exists to enforce: a job that throws must never take the process with it. These
 * run fire-and-forget off agent events, so before this an unhandled rejection was a live
 * process kill — see the subprocess test at the bottom, which is the regression test for
 * exactly that.
 */

/** A promise plus the handles to settle it, so a test can hold a job open deliberately. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve: () => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('coalesce', () => {
  test('runs the job', async () => {
    let runs = 0
    const run = coalesce(
      async () => {
        runs++
      },
      () => {},
    )

    run()
    await settle()
    expect(runs).toBe(1)
  })

  test('requests arriving during a run collapse into exactly one more', async () => {
    let runs = 0
    const held = deferred()
    const run = coalesce(
      async () => {
        runs++
        if (runs === 1) await held.promise
      },
      () => {},
    )

    run()
    await settle()
    expect(runs).toBe(1)

    run()
    run()
    run()
    held.resolve()
    await settle()
    expect(runs).toBe(2)
  })

  test('a job that rejects is reported rather than thrown away', async () => {
    const failure = new Error('the board could not be read')
    const seen: unknown[] = []
    const run = coalesce(
      async () => {
        throw failure
      },
      (error) => seen.push(error),
    )

    run()
    await settle()
    expect(seen).toEqual([failure])
  })

  test('a job that rejects does not wedge the runner', async () => {
    // The `running` flag has to be cleared on the failure path too, or one failed board
    // refresh would silently stop every later one — the board frozen with no way back.
    let runs = 0
    const run = coalesce(
      async () => {
        runs++
        if (runs === 1) throw new Error('first one fails')
      },
      () => {},
    )

    run()
    await settle()
    run()
    await settle()
    expect(runs).toBe(2)
  })

  test('a request queued during a run that then rejects still causes the rerun', async () => {
    let runs = 0
    const held = deferred()
    const run = coalesce(
      async () => {
        runs++
        if (runs === 1) await held.promise
      },
      () => {},
    )

    run()
    await settle()
    run() // queued while the first is still in flight
    held.reject(new Error('the in-flight one fails'))
    await settle()
    expect(runs).toBe(2)
  })

  test('a reporter that itself throws does not wedge the runner', async () => {
    // `onError` is the last thing standing between a failed job and an unhandled rejection,
    // so it cannot be trusted to be infallible either — it reaches `update()`, which fans out
    // to every connected socket.
    let runs = 0
    const run = coalesce(
      async () => {
        runs++
        throw new Error('the job fails')
      },
      () => {
        throw new Error('and so does reporting it')
      },
    )

    run()
    await settle()
    run()
    await settle()
    expect(runs).toBe(2)
  })

  test('a rejecting job does not kill the process', async () => {
    // The regression test for the actual bug: these jobs are fired and forgotten, and an
    // unhandled rejection in Bun terminates the process outright. Asserting on the exit code
    // of a real subprocess is the only way to prove that from inside a test.
    const module = new URL('../../src/app/coalesce.ts', import.meta.url).pathname
    const source = `
      import { coalesce } from ${JSON.stringify(module)}
      const run = coalesce(async () => { throw new Error('boom') }, () => {})
      run()
      setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 50)
    `
    const proc = Bun.spawn(['bun', '-e', source], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    expect(stdout).toContain('SURVIVED')
    expect(exitCode).toBe(0)
  })
})
