/**
 * Calls `onGone` once, when the process that started this one has died.
 *
 * The desktop app runs this binary as a sidecar and kills it on a graceful quit, but a parent
 * that is killed outright — `tauri dev` restarting the app after a rebuild, a crash — runs no
 * exit handler, and macOS has no `PR_SET_PDEATHSIG` to take the child down with it. Orphaned
 * sidecars kept their `claude` running against the session the new app then tried to resume.
 *
 * An orphan is reparented, so its ppid changes; that is the whole check. Polled, since nothing
 * notifies a process of its parent's death.
 */
export function watchParent(
  onGone: () => void,
  options: { ppid?: () => number; intervalMs?: number } = {},
): () => void {
  const ppid = options.ppid ?? (() => process.ppid)
  const parent = ppid()
  const timer = setInterval(() => {
    if (ppid() === parent) return
    clearInterval(timer)
    onGone()
  }, options.intervalMs ?? 1000)
  timer.unref()
  return () => clearInterval(timer)
}
