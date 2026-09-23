/// The server URL from the sidecar's startup line (`turnstile: http://127.0.0.1:<port>/`).
///
/// Requires the rest of the line to be an http(s) URL, not merely the prefix: the window is
/// navigated to whatever this returns, so a stray `turnstile: ` line must never count.
pub fn parse_listen_url(line: &str) -> Option<String> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    trimmed
        .strip_prefix("turnstile: ")
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .map(|url| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_url_from_the_turnstile_startup_line() {
        assert_eq!(
            parse_listen_url("turnstile: http://127.0.0.1:54321/"),
            Some("http://127.0.0.1:54321/".to_string())
        );
    }

    #[test]
    fn strips_trailing_newline_or_carriage_return() {
        assert_eq!(
            parse_listen_url("turnstile: http://127.0.0.1:54321/\r\n"),
            Some("http://127.0.0.1:54321/".to_string())
        );
    }

    #[test]
    fn ignores_unrelated_stdout_lines() {
        assert_eq!(parse_listen_url("some other log line"), None);
        assert_eq!(parse_listen_url(""), None);
    }

    #[test]
    fn ignores_lines_that_look_close_but_are_not_the_prefix() {
        assert_eq!(parse_listen_url("not turnstile: http://127.0.0.1:54321/"), None);
    }

    /// Regression: the app's "not a git repository" notice once started with the same prefix,
    /// and was navigated to as if it were the server's URL — reloading the launcher page, which
    /// restarted the sidecar, which printed the notice again, forever.
    #[test]
    fn ignores_a_turnstile_line_that_is_not_a_url() {
        assert_eq!(
            parse_listen_url(
                "turnstile: this directory is not a git repository — no session opened."
            ),
            None
        );
    }
}

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use crate::state::SidecarState;

#[derive(Clone, serde::Serialize)]
struct SidecarReady {
    url: String,
}

#[derive(Clone, serde::Serialize)]
struct SidecarError {
    message: String,
}

/// Path to the bundled native `claude` binary, if `prepare-sidecar.mjs` copied it into the
/// packaged app's resources (see its own doc comment) — i.e. only in a `tauri build` output.
/// Resources are only ever copied into a bundle, so `resource_dir()` never resolves to anything
/// real under `tauri dev`. `start` below only sets `TURNSTILE_CLAUDE_CODE_EXECUTABLE` when this
/// returns `Some`, so dev mode is unaffected: `resolveExecutable()` in
/// `src/adapters/agent-sdk/resolveExecutable.ts` falls through to its own repo-relative
/// directory walk exactly as it did before this existed, since dev's sidecar binary is still
/// sitting inside the repo checkout.
fn bundled_claude_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    // Tauri mirrors the full source path (`resources/claude-cli` in tauri.conf.json's
    // `bundle.resources`) under the platform resource dir rather than just the leaf directory
    // name — confirmed against `tauri-utils`' own `ResourcePaths`/`resource_relpath`
    // implementation (the version pinned in Cargo.lock), and against an actual `tauri build`
    // output, not assumed.
    let cli_ext = if cfg!(windows) { ".exe" } else { "" };
    let path = resource_dir.join("resources/claude-cli").join(format!("claude{cli_ext}"));
    path.exists().then_some(path)
}

/// Spawns a new sidecar against `folder` (killing any previously tracked one first, atomically,
/// via `SidecarState::replace`), and streams its output until either a listen URL is found
/// (emits `sidecar-ready`) or the process ends without one (emits `sidecar-error`).
///
/// The reader task below is tagged with the generation `replace` returns, and every emit (or
/// state mutation) it performs is gated on that generation still being current. Without this, a
/// stale reader task left over from a sidecar that a later `start_project` call killed could
/// still emit `sidecar-ready`/`sidecar-error` for a project the user already switched away from,
/// racing nondeterministically against the new sidecar's own events.
pub async fn start(app: AppHandle, folder: String) -> Result<(), String> {
    let state = app.state::<SidecarState>();

    let mut command = app
        .shell()
        .sidecar("turnstile")
        .map_err(|e| e.to_string())?
        .current_dir(&folder)
        // `kill_current()` on `RunEvent::Exit` only covers a graceful quit; this makes the
        // sidecar exit on its own when this process dies any other way (see parentWatch.ts).
        .env("TURNSTILE_EXIT_WITH_PARENT", "1");

    if let Some(claude_path) = bundled_claude_path(&app) {
        command = command.env("TURNSTILE_CLAUDE_CODE_EXECUTABLE", claude_path);
    }

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    let my_gen = state.replace(child);

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_for_task.state::<SidecarState>();
        let mut found_url = false;
        let mut stderr_tail = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_listen_url(&line) {
                        found_url = true;
                        if state.is_current(my_gen) {
                            let _ = app_for_task.emit("sidecar-ready", SidecarReady { url });
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    // Clears the tracked child (if this generation is still the live one) even
                    // when `found_url` is true, so state doesn't keep pointing at a dead process.
                    let still_current = state.finish_if_current(my_gen);
                    if still_current && !found_url {
                        let message = if stderr_tail.trim().is_empty() {
                            format!("turnstile exited before starting (code {:?})", payload.code)
                        } else {
                            stderr_tail.trim().to_string()
                        };
                        let _ = app_for_task.emit("sidecar-error", SidecarError { message });
                    }
                    break;
                }
                CommandEvent::Error(message) => {
                    if state.finish_if_current(my_gen) {
                        let _ = app_for_task.emit("sidecar-error", SidecarError { message });
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}
