/**
 * Run a job one at a time, without losing what arrives while it runs.
 *
 * Edits come in bursts — several per second while the agent writes files — and both the
 * board rebuild and the analysis pass hang off them. Skipping while one is in flight drops
 * edits and leaves the board frozen on whatever the first one produced, so instead: one at a
 * time, and anything that arrived during a run causes exactly one more.
 *
 * Every caller fires these and forgets them, which makes the `catch` load-bearing rather than
 * tidy: an unhandled rejection terminates the Bun process outright, so without it one failed
 * board refresh takes the whole app down mid-session. `onError` is how the failure stays
 * visible instead of silently disappearing — a background job that gives up without saying so
 * leaves the board quietly stale, which reads as a bug in the board rather than a failed read.
 */
export function coalesce(job: () => Promise<void>, onError: (error: unknown) => void): () => void {
  let running = false
  let again = false

  const run = (): void => {
    if (running) {
      again = true
      return
    }
    running = true
    void (async () => {
      try {
        await job()
      } catch (error) {
        try {
          onError(error)
        } catch {
          // The one place swallowing is right rather than lazy: reporting has already failed,
          // so there is nowhere left to report to, and letting this escape would be the very
          // process kill the outer catch exists to prevent. A job failure still surfaces
          // through `onError` normally — only a failure *of the reporting itself* lands here.
        }
      } finally {
        // Cleared on the failure path too: otherwise one failed run wedges `running` on
        // forever and every later request is silently swallowed as "already running".
        running = false
        if (again) {
          again = false
          run()
        }
      }
    })()
  }

  return run
}
