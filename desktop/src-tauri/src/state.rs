use std::sync::Mutex;

use tauri_plugin_shell::process::CommandChild;

/// How long the Unix path below waits after `SIGTERM` before escalating to `SIGKILL`, at both
/// real call sites below. Sized for `roots.teardown()` (`src/cli/app.ts`'s `shutdown()`) —
/// dropping a synthetic git root's owned database, ledger/origin records, and recorded baseline —
/// to finish on an ordinary repo, with headroom for a slower filesystem; not sized to cover the
/// Claude Agent SDK's own internal close() escalation for its `claude` child, since
/// `shutdown()` calls `process.exit(0)` immediately after `session.stop()` without awaiting that
/// escalation, so it essentially never runs to completion regardless of how long this waits.
#[cfg(unix)]
const GRACE_PERIOD: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(unix)]
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// Sends `SIGTERM` to `pid` and waits, in small polling increments, up to `grace_period` for it
/// to exit on its own before falling back to `SIGKILL`. Blocking (not fire-and-forget): a
/// spawned async fallback task has no guarantee of ever running if the whole app process exits
/// first — there is nothing in `RunEvent::Exit` that awaits background tasks — so the only way
/// to guarantee the escalation half of this actually happens is to wait for it inline.
///
/// Takes a raw pid rather than a [`CommandChild`] so it stays testable against a plain
/// `std::process::Command`-spawned process, and so `terminate` below can extract the pid and
/// let its `CommandChild` drop (which does not itself kill the process) before blocking, rather
/// than holding one open across the wait.
#[cfg(unix)]
fn terminate_gracefully(pid: u32, grace_period: std::time::Duration) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    use std::time::Instant;

    let pid = Pid::from_raw(pid as i32);

    if kill(pid, Signal::SIGTERM).is_err() {
        return; // Already gone (ESRCH) — nothing left to wait for or escalate.
    }

    let deadline = Instant::now() + grace_period;
    while Instant::now() < deadline {
        // Signal 0 (`None` here) sends nothing — it's the standard POSIX liveness probe: Err
        // means the pid is no longer ours to signal, i.e. it has exited.
        if kill(pid, None).is_err() {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    let _ = kill(pid, Signal::SIGKILL);
}

/// Terminates a sidecar we're done with — see [`SidecarState::replace`]'s doc comment for why
/// this isn't just an immediate hard kill any more. On Windows this remains exactly that
/// immediate kill: `tauri_plugin_shell::process::CommandChild` exposes no SIGTERM equivalent
/// there (Windows has no such signal), and building a real graceful-stop path would mean a
/// second, unverified mechanism (e.g. `CTRL_BREAK_EVENT` to a process group) — left as a known
/// gap versus the Unix behavior below, not fixed here, since this bug was only ever reproduced
/// on macOS.
fn terminate(old: CommandChild) {
    #[cfg(unix)]
    {
        terminate_gracefully(old.pid(), GRACE_PERIOD);
    }
    #[cfg(not(unix))]
    {
        let _ = old.kill();
    }
}

#[derive(Default)]
struct Inner {
    child: Option<CommandChild>,
    generation: u64,
}

#[derive(Default)]
pub struct SidecarState(Mutex<Inner>);

impl SidecarState {
    /// Replaces whatever sidecar is currently tracked with `new_child`, returning the new
    /// generation number, and terminates whichever one it replaced (if any) — see
    /// [`terminate`]. The take-and-store happens under a single lock acquisition, so two racing
    /// `start_project` calls can never both store a child without the loser's being terminated —
    /// previously, two separate lock acquisitions (kill, then later store) let one call's kill
    /// interleave with another's store, so the child stored by the call that lost the race got
    /// silently overwritten and its `CommandChild` dropped without ever being killed (dropping
    /// does not kill the process).
    ///
    /// The actual termination happens *after* releasing the lock, deliberately: `is_current`/
    /// `finish_if_current` below share this same mutex, and a new sidecar's reader task
    /// (`sidecar.rs`) calls `is_current` to decide whether to emit `sidecar-ready` — holding the
    /// lock across a multi-second grace-period wait would delay that emit by however long the
    /// old sidecar took to exit, stalling "Open Folder" behind a process that's no longer
    /// relevant to it.
    ///
    /// ## SIGTERM, then SIGKILL only if needed (Unix)
    ///
    /// This used to send `SIGKILL` outright via `CommandChild::kill()`. That skips the tracked
    /// sidecar's own `SIGTERM` handler (`src/cli/app.ts`'s `shutdown()`) entirely — signal 9
    /// can't be caught — which is what runs `roots.teardown()`. The `claude` grandchild the
    /// Claude Agent SDK spawns turned out not to be the actual casualty of that: confirmed live
    /// that it exits on its own within a couple of seconds either way, since closing the
    /// sidecar's own stdin (which happens whether the sidecar dies via a caught `SIGTERM` or the
    /// OS's automatic fd cleanup on any process death, including `SIGKILL`) is what the `claude`
    /// process actually reacts to. What a raw `SIGKILL` was actually skipping was
    /// `roots.teardown()` itself — dropping a synthetic git root's owned database,
    /// ledger/origin records, and recorded baseline — which never got a chance to run at all, on
    /// every single project switch and app quit. That's a real on-disk cleanup gap, not just a
    /// process-count one.
    pub fn replace(&self, new_child: CommandChild) -> u64 {
        let (old, new_generation) = {
            let mut inner = self.0.lock().unwrap();
            let old = inner.child.take();
            inner.child = Some(new_child);
            inner.generation += 1;
            (old, inner.generation)
        };
        if let Some(old) = old {
            terminate(old);
        }
        new_generation
    }

    /// Terminates whatever sidecar is currently tracked, if any, and clears it. Used on app
    /// exit. See [`Self::replace`]'s doc comment for why this sends `SIGTERM` (with a bounded
    /// wait, on Unix) rather than the `SIGKILL` it used to send outright.
    pub fn kill_current(&self) {
        let old = {
            let mut inner = self.0.lock().unwrap();
            let old = inner.child.take();
            inner.generation += 1;
            old
        };
        if let Some(old) = old {
            terminate(old);
        }
    }

    /// True if `gen` is still the live generation — i.e. no newer `start_project` call has
    /// superseded it. Used to gate an in-flight reader task's `sidecar-ready` emit, which
    /// doesn't touch the tracked child (the process is still running).
    pub fn is_current(&self, gen: u64) -> bool {
        self.0.lock().unwrap().generation == gen
    }

    /// Call when a reader task's own sidecar (tagged `gen`) terminates on its own, as opposed to
    /// being replaced by a newer `start_project` call (which already cleared the tracked child as
    /// part of `replace`). If `gen` is still the live generation, clears the tracked child and
    /// returns `true` (the caller should go on to emit `sidecar-error`); otherwise a newer
    /// sidecar has since taken over and this returns `false` (the caller must stay silent — its
    /// generation is stale, and emitting would report on a project the user already abandoned).
    pub fn finish_if_current(&self, gen: u64) -> bool {
        let mut inner = self.0.lock().unwrap();
        if inner.generation == gen {
            inner.child = None;
            true
        } else {
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// A real, disposable process to signal — not a mock, since the whole point of
    /// `terminate_gracefully` is its interaction with actual OS signal delivery. Returns just
    /// the raw pid, reaped on a background thread rather than handed back as a `Child` — the
    /// same division of responsibility real usage has (tauri-plugin-shell owns reaping its
    /// sidecar via its own wait thread; `terminate_gracefully` only ever signals and polls a raw
    /// pid, never touching a `Child`/`CommandChild` itself). Reaping matters here, concretely:
    /// confirmed directly (a standalone repro, not assumed) that `kill(pid, 0)` reports an
    /// unreaped zombie as alive — so a test that only calls `.wait()` after asserting liveness
    /// would see a false "still alive" for a process that has, in fact, already died.
    fn spawn_sleeper() -> u32 {
        reap_in_background(
            Command::new("sleep")
                .arg("100")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn test fixture process"),
        )
    }

    fn spawn_sigterm_ignorer() -> u32 {
        reap_in_background(
            Command::new("sh")
                .args(["-c", "trap '' TERM; sleep 100"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn test fixture process"),
        )
    }

    fn reap_in_background(child: std::process::Child) -> u32 {
        let pid = child.id();
        let mut child = child;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        pid
    }

    fn is_alive(pid: u32) -> bool {
        kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    #[test]
    fn terminates_an_ordinary_process_via_sigterm_within_the_grace_period() {
        let pid = spawn_sleeper();

        terminate_gracefully(pid, Duration::from_secs(2));

        assert!(!is_alive(pid), "process should have exited via SIGTERM");
    }

    #[test]
    fn falls_back_to_sigkill_when_the_process_ignores_sigterm() {
        let pid = spawn_sigterm_ignorer();

        // Short grace period so the fallback-SIGKILL path is exercised quickly rather than
        // waiting out the real (3s) production constant.
        terminate_gracefully(pid, Duration::from_millis(300));

        assert!(!is_alive(pid), "process should have been SIGKILLed after ignoring SIGTERM");
    }

    #[test]
    fn does_nothing_harmful_when_the_pid_is_already_gone() {
        let pid = spawn_sleeper();
        kill(Pid::from_raw(pid as i32), Signal::SIGKILL).unwrap();
        // Give the background reaper a moment to actually reap it, so this exercises the
        // already-gone (ESRCH) path rather than racing the zombie window.
        std::thread::sleep(Duration::from_millis(100));

        // Must not panic or hang on an already-dead pid.
        terminate_gracefully(pid, Duration::from_millis(200));
    }
}
