# Native Shell (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ISR's browser-tab UI with a real native desktop window, with zero functional change and zero changes to `src/core`, `src/app`, `src/adapters`, or the React UI.

**Architecture:** A new `desktop/` Tauri (v2) project spawns the existing compiled `isr` binary as a sidecar process, reads the `isr: http://127.0.0.1:<port>/` line it already prints to stdout, and switches the native window to that URL. A thin Rust layer owns sidecar lifecycle (spawn, kill on quit) and project-folder selection (there's no shell `cwd` for a double-clicked app to inherit); a thin plain-JS frontend owns the loading/error screen shown before that URL is known.

**Tech Stack:** Tauri 2.x (Rust), `tauri-plugin-shell` (sidecar process), `tauri-plugin-dialog` (folder picker), `tauri-plugin-store` (remember last folder), plain HTML/JS for the loading screen (no framework — the real UI is the existing React app served by the sidecar).

**Spec:** `docs/superpowers/specs/2026-09-01-native-shell-design.md`

## Global Constraints

- Zero changes to `src/core`, `src/app`, `src/adapters/*`, or `adapters/web/ui/*` — the sidecar is a black box the desktop shell spawns and points a window at.
- Target platform for Phase 1: macOS only.
- Sidecar is launched with `ISR_NO_BROWSER=1` (already-supported env var) so it never opens its own OS browser tab.
- No auto-update, no code signing/distribution work, no multi-window/multi-project-at-once support — single window, single project, at a time.
- No new automated tests are expected in `src/` — `bun test`'s existing 340+ tests must still pass unmodified. New Rust code gets `cargo test` coverage only where it's pure logic (Task 3); everything else is manually verified, per the spec's own Testing section.

---

## Prerequisite check (do this before Task 1)

Rust is not currently installed on this machine. Before starting Task 1:

- [ ] **Step 1: Check for the Rust toolchain**

Run: `rustc --version && cargo --version`
Expected: version output for both. If either command is not found, continue to Step 2; otherwise skip to Task 1.

- [ ] **Step 2: Install Rust via rustup**

Run: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` then `source "$HOME/.cargo/env"`

- [ ] **Step 3: Verify**

Run: `rustc --version && cargo --version`
Expected: version output for both, no "command not found" errors.

---

### Task 1: Scaffold the Tauri project

**Files:**
- Create: `desktop/` (entire directory tree, via scaffolding tool)

**Interfaces:**
- Produces: a working `desktop/` Tauri project with `desktop/src-tauri/` (Rust backend) and `desktop/src/` (plain HTML/JS frontend), buildable with `bun run tauri dev`.

- [ ] **Step 1: Scaffold with the official create tool**

Run (from the `isr` repo root):
```bash
bun create tauri-app@latest desktop
```
When prompted, choose:
- Package manager: `bun`
- UI template: `Vanilla`
- UI flavor: `JavaScript`

This creates `desktop/src-tauri/` (Cargo.toml, tauri.conf.json, src/main.rs, capabilities/, icons/) and `desktop/src/` (index.html, main.js, styles.css).

- [ ] **Step 2: Install dependencies**

Run: `cd desktop && bun install`

- [ ] **Step 3: Verify the default scaffold builds and runs**

Run: `bun run tauri dev`
Expected: a native window opens showing the default Tauri/Vanilla template page (a Tauri logo and a greet form). This confirms the Rust toolchain, Tauri CLI, and scaffold are all wired correctly before any custom code is added. Close the window / Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/isr
git add desktop/
git commit -m "$(cat <<'EOF'
Scaffold Tauri desktop shell project

Bare bun create tauri-app scaffold (Vanilla JS template) as the
starting point for Phase 1 of the native shell roadmap.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 2: Sidecar binary pipeline

**Files:**
- Create: `desktop/scripts/prepare-sidecar.mjs`
- Modify: `desktop/src-tauri/tauri.conf.json`
- Modify: `desktop/package.json`

**Interfaces:**
- Consumes: root `bun run build` (existing script, produces `dist/isr` — unmodified).
- Produces: `desktop/src-tauri/binaries/isr-<target-triple>`, referenced by `tauri.conf.json`'s `bundle.externalBin` as `"binaries/isr"`, and available to Task 5's `Command::sidecar("isr")` call under the sidecar name `isr`.

- [ ] **Step 1: Write the prepare-sidecar script**

Create `desktop/scripts/prepare-sidecar.mjs`:
```js
#!/usr/bin/env bun
import { $ } from 'bun'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const repoRoot = new URL('../..', import.meta.url).pathname
const desktopRoot = new URL('..', import.meta.url).pathname

console.log('Building isr binary...')
await $`bun run build`.cwd(repoRoot)

const sourceBinary = `${repoRoot}/dist/isr`
if (!existsSync(sourceBinary)) {
  throw new Error(`Expected ${sourceBinary} after \`bun run build\` — not found`)
}

const hostLine = (await $`rustc -Vv`.text()).split('\n').find((line) => line.startsWith('host: '))
if (!hostLine) throw new Error('Could not determine target triple from `rustc -Vv`')
const targetTriple = hostLine.replace('host: ', '').trim()

const binariesDir = `${desktopRoot}/src-tauri/binaries`
await mkdir(binariesDir, { recursive: true })

const destBinary = `${binariesDir}/isr-${targetTriple}`
await copyFile(sourceBinary, destBinary)
await chmod(destBinary, 0o755)

console.log(`Prepared sidecar: ${destBinary}`)
```

- [ ] **Step 2: Point Tauri at the sidecar**

In `desktop/src-tauri/tauri.conf.json`, add (or merge into) the `bundle` and `build` sections:
```json
{
  "bundle": {
    "externalBin": ["binaries/isr"]
  },
  "build": {
    "beforeDevCommand": "bun run prepare-sidecar",
    "beforeBuildCommand": "bun run prepare-sidecar"
  }
}
```
Keep every other existing key in the file as the scaffold generated it — only add/merge these.

- [ ] **Step 3: Add the npm scripts**

In `desktop/package.json`, add to `"scripts"`:
```json
"prepare-sidecar": "bun scripts/prepare-sidecar.mjs",
"build:desktop": "tauri build"
```
`build:desktop` doesn't need to call `prepare-sidecar` itself — `beforeBuildCommand` (Step 2) already runs it automatically before every `tauri build`.

- [ ] **Step 4: Verify the sidecar is prepared and bundled**

Run: `cd desktop && bun run prepare-sidecar`
Expected: prints `Building isr binary...` then `Prepared sidecar: .../desktop/src-tauri/binaries/isr-<your-triple>`, and that file exists and is executable (`ls -la src-tauri/binaries/`).

Run: `bun run tauri dev`
Expected: still opens the default template window (the sidecar isn't spawned yet — this just confirms `beforeDevCommand` runs `prepare-sidecar` without erroring, and Tauri accepts the `externalBin` config). If Tauri logs a capability/permission warning about the sidecar at this point, ignore it for now — Task 5 adds the code that actually spawns it, and Task 5 covers granting the right permission.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/ desktop/src-tauri/tauri.conf.json desktop/package.json
git commit -m "$(cat <<'EOF'
Bundle the isr binary as a Tauri sidecar

prepare-sidecar.mjs builds the existing dist/isr binary and copies it
into src-tauri/binaries/ with the target-triple suffix Tauri expects,
wired to run automatically before tauri dev/build.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 3: Sidecar output line parser (pure function, TDD)

**Files:**
- Create: `desktop/src-tauri/src/sidecar.rs`
- Modify: `desktop/src-tauri/src/main.rs:1` (add `mod sidecar;`)

**Interfaces:**
- Produces: `pub fn parse_listen_url(line: &str) -> Option<String>`, consumed by Task 5's stdout-reading loop.

- [ ] **Step 1: Write the failing tests**

Create `desktop/src-tauri/src/sidecar.rs`:
```rust
pub fn parse_listen_url(line: &str) -> Option<String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_url_from_the_isr_startup_line() {
        assert_eq!(
            parse_listen_url("isr: http://127.0.0.1:54321/"),
            Some("http://127.0.0.1:54321/".to_string())
        );
    }

    #[test]
    fn strips_trailing_newline_or_carriage_return() {
        assert_eq!(
            parse_listen_url("isr: http://127.0.0.1:54321/\r\n"),
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
        assert_eq!(parse_listen_url("not isr: http://127.0.0.1:54321/"), None);
    }
}
```

Add `mod sidecar;` near the top of `desktop/src-tauri/src/main.rs` (with the other `mod`/`use` statements the scaffold generated).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop/src-tauri && cargo test sidecar::`
Expected: compiles, then panics on `todo!()` for each test — confirms the tests actually exercise the function before it's implemented.

- [ ] **Step 3: Implement**

Replace the `todo!()` body:
```rust
pub fn parse_listen_url(line: &str) -> Option<String> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    trimmed.strip_prefix("isr: ").map(|url| url.to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test sidecar::`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/sidecar.rs desktop/src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
Add pure parser for the isr sidecar's startup URL line

Task 5 wires this to the sidecar's real stdout stream; kept as a pure
function here so the parsing logic is unit-tested independent of
process I/O.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 4: Project-folder commands (remember + pick)

**Files:**
- Create: `desktop/src-tauri/src/project.rs`
- Modify: `desktop/src-tauri/src/main.rs` (register plugins, register commands, add `mod project;`)
- Modify: `desktop/src-tauri/Cargo.toml` (add `tauri-plugin-dialog`, `tauri-plugin-store`)
- Modify: `desktop/package.json` (add `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-store` — the JS-side bindings, used later by the frontend in Task 6)
- Modify: `desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Produces:
  - `#[tauri::command] fn get_remembered_project(app: AppHandle) -> Option<String>`
  - `#[tauri::command] async fn choose_project_folder(app: AppHandle) -> Option<String>`
  - Both registered in the `tauri::generate_handler!` list in `main.rs`, callable from the frontend via `invoke("get_remembered_project")` / `invoke("choose_project_folder")` (Task 6 does the calling).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Add the Rust dependencies**

Run inside `desktop/src-tauri`:
```bash
cargo add tauri-plugin-dialog
cargo add tauri-plugin-store
```

- [ ] **Step 2: Add the JS-side plugin bindings**

Run inside `desktop`:
```bash
bun add @tauri-apps/plugin-dialog @tauri-apps/plugin-store
```

- [ ] **Step 3: Register the plugins**

In `desktop/src-tauri/src/main.rs`, find the `tauri::Builder::default()` chain the scaffold generated and add these two plugin calls (order doesn't matter, but both must be added before `.run(...)`):
```rust
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_store::Builder::new().build())
```

- [ ] **Step 4: Write the project-folder commands**

Create `desktop/src-tauri/src/project.rs`:
```rust
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "desktop-settings.json";
const LAST_PROJECT_KEY: &str = "lastProject";

#[tauri::command]
pub fn get_remembered_project(app: AppHandle) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(LAST_PROJECT_KEY)?.as_str().map(|s| s.to_string())
}

#[tauri::command]
pub async fn choose_project_folder(app: AppHandle) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder()?;
    let path = folder.to_string();

    if let Ok(store) = app.store(STORE_FILE) {
        store.set(LAST_PROJECT_KEY, serde_json::json!(path));
        let _ = store.save();
    }

    Some(path)
}
```

- [ ] **Step 5: Wire the module in**

In `desktop/src-tauri/src/main.rs`: add `mod project;`, and add both commands to the existing `tauri::generate_handler![...]` call:
```rust
tauri::generate_handler![project::get_remembered_project, project::choose_project_folder]
```
(If the scaffold's `generate_handler!` already lists a `greet` command from the template, keep it for now — it gets removed in Task 6 when the template's default frontend is replaced.)

- [ ] **Step 6: Grant permissions**

Run: `cd desktop && bun run tauri dev`, then trigger `choose_project_folder` however is easiest at this point — the scaffold's default page has an input+button wired to `invoke`; temporarily change its `invoke("greet", ...)` call in `desktop/src/main.js` to `invoke("choose_project_folder")` to test, or just watch the terminal for a permission-denied error the first time any command runs.

Expected: Tauri's dev console prints a `capability` error naming the exact permission string missing (e.g. `dialog:allow-open` and/or store permissions). Add each one it names to the `"permissions"` array in `desktop/src-tauri/capabilities/default.json`. Repeat run-and-fix until `choose_project_folder` opens a native folder picker with no console errors. Revert the temporary `main.js` change afterward — Task 6 replaces `main.js` properly.

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/src/project.rs desktop/src-tauri/src/main.rs desktop/src-tauri/Cargo.toml desktop/src-tauri/capabilities/default.json desktop/package.json
git commit -m "$(cat <<'EOF'
Add project-folder commands: remember last folder, folder picker

get_remembered_project reads the last-opened project from a local
store; choose_project_folder opens a native folder dialog and
persists the choice. Both are Tauri commands the frontend (Task 6)
calls on startup.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 5: `start_project` command — spawn, stream, emit

**Files:**
- Create: `desktop/src-tauri/src/state.rs`
- Modify: `desktop/src-tauri/src/sidecar.rs` (add the spawn/stream logic alongside Task 3's parser)
- Modify: `desktop/src-tauri/src/main.rs` (manage state, register command, kill-on-exit)
- Modify: `desktop/src-tauri/Cargo.toml` (add `tauri-plugin-shell`)
- Modify: `desktop/package.json` (add `@tauri-apps/plugin-shell`)
- Modify: `desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `sidecar::parse_listen_url` (Task 3).
- Produces:
  - `#[tauri::command] async fn start_project(app: AppHandle, folder: String) -> Result<(), String>`, registered in `generate_handler!`, called by the frontend (Task 6) after a folder is known.
  - Emits window event `"sidecar-ready"` with payload `{ "url": string }` on success.
  - Emits window event `"sidecar-error"` with payload `{ "message": string }` if the sidecar exits before printing a URL, or fails to spawn.
  - `SidecarState` (managed via `app.manage(...)`), holding the current `Option<CommandChild>`, so a later call to `start_project` (Task 7's "switch project") kills the previous sidecar first.

- [ ] **Step 1: Add the shell plugin dependency**

Run inside `desktop/src-tauri`: `cargo add tauri-plugin-shell`
Run inside `desktop`: `bun add @tauri-apps/plugin-shell`

Register it in `main.rs` alongside the Task 4 plugins:
```rust
.plugin(tauri_plugin_shell::init())
```

- [ ] **Step 2: Add shared sidecar state**

Create `desktop/src-tauri/src/state.rs`:
```rust
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<CommandChild>>);

impl SidecarState {
    /// Kills whatever sidecar is currently tracked, if any, and clears it.
    pub fn kill_current(&self) {
        if let Some(child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}
```

Add `mod state;` to `main.rs` and, in the `tauri::Builder` chain, add:
```rust
.manage(state::SidecarState::default())
```

- [ ] **Step 3: Add the spawn/stream function to sidecar.rs**

Append to `desktop/src-tauri/src/sidecar.rs` (below the existing `parse_listen_url` and its `#[cfg(test)]` module — do not touch those):
```rust
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

/// Kills any previously tracked sidecar, spawns a new one against `folder`, and streams its
/// output until either a listen URL is found (emits `sidecar-ready`) or the process ends
/// without one (emits `sidecar-error`).
pub async fn start(app: AppHandle, folder: String) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    state.kill_current();

    let (mut rx, child) = app
        .shell()
        .sidecar("isr")
        .map_err(|e| e.to_string())?
        .current_dir(&folder)
        .env("ISR_NO_BROWSER", "1")
        .spawn()
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(child);

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut found_url = false;
        let mut stderr_tail = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_listen_url(&line) {
                        found_url = true;
                        let _ = app_for_task.emit("sidecar-ready", SidecarReady { url });
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    if !found_url {
                        let message = if stderr_tail.trim().is_empty() {
                            format!("isr exited before starting (code {:?})", payload.code)
                        } else {
                            stderr_tail.trim().to_string()
                        };
                        let _ = app_for_task.emit("sidecar-error", SidecarError { message });
                    }
                    break;
                }
                CommandEvent::Error(message) => {
                    let _ = app_for_task.emit("sidecar-error", SidecarError { message });
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}
```

- [ ] **Step 4: Add the `start_project` command**

Append to `desktop/src-tauri/src/project.rs`:
```rust
#[tauri::command]
pub async fn start_project(app: AppHandle, folder: String) -> Result<(), String> {
    crate::sidecar::start(app, folder).await
}
```

Register it in `main.rs`'s `generate_handler!` list alongside the Task 4 commands:
```rust
tauri::generate_handler![
    project::get_remembered_project,
    project::choose_project_folder,
    project::start_project,
]
```

- [ ] **Step 5: Kill the sidecar on app exit**

In `main.rs`, on the `tauri::Builder` chain, add an exit handler (exact hook name may be `.on_window_event` for the main window's `CloseRequested`, or `RunEvent::ExitRequested` passed to `.run(...)` — use whichever the installed Tauri version's generated scaffold pattern supports; check `desktop/src-tauri/src/main.rs`'s existing `.run(tauri::generate_context!())` call signature). Concretely:
```rust
.build(tauri::generate_context!())
.expect("error while building tauri application")
.run(|app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        app_handle.state::<state::SidecarState>().kill_current();
    }
})
```
This replaces whatever `.run(tauri::generate_context!())` call the scaffold generated — swap `.run(tauri::generate_context!())` for `.build(tauri::generate_context!())...expect(...)...run(...)` as shown, keeping every `.plugin(...)`/`.manage(...)`/`.invoke_handler(...)` call before it unchanged.

- [ ] **Step 6: Grant the shell permission**

Run: `cd desktop && bun run tauri dev`, then (temporarily, same technique as Task 4 Step 6) call `invoke("start_project", { folder: "/tmp" })` from the dev console (open it via the window's right-click menu, or add a temporary button) and watch for a capability error naming the missing `shell:allow-execute` (or sidecar-scoped) permission. Add it to `desktop/src-tauri/capabilities/default.json`, scoped to the `isr` sidecar — Tauri's error output shows the exact JSON shape it expects; match it. Repeat until `start_project` runs without a permission error and either a `sidecar-ready` or `sidecar-error` event fires (check via the dev console: `window.__TAURI__.event.listen('sidecar-ready', console.log)` before invoking).

- [ ] **Step 7: Verify against a real project**

Run `invoke("start_project", { folder: "~/projects/isr" })` from the dev console.
Expected: a `sidecar-ready` event fires with a `url` like `http://127.0.0.1:<port>/`. Open that URL in a regular browser tab to confirm the ISR UI loads normally — this proves the sidecar actually started ISR's server against a real ACP-capable repo. Then quit the Tauri dev app and confirm the spawned `isr` process is gone: `ps aux | grep isr` should show nothing.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/sidecar.rs desktop/src-tauri/src/state.rs desktop/src-tauri/src/project.rs desktop/src-tauri/src/main.rs desktop/src-tauri/Cargo.toml desktop/src-tauri/capabilities/default.json desktop/package.json
git commit -m "$(cat <<'EOF'
Add start_project command: spawn sidecar, emit ready/error events

Kills any previously tracked sidecar, spawns dist/isr against the
chosen folder with ISR_NO_BROWSER=1, and streams its stdout through
the Task 3 parser. Emits sidecar-ready with the listen URL, or
sidecar-error if the process exits before printing one. The sidecar
child is tracked in managed state and killed on app exit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 6: Loading/error frontend

**Files:**
- Modify: `desktop/src/index.html` (replace scaffold template content)
- Modify: `desktop/src/main.js` (replace scaffold template content)
- Delete: `desktop/src/styles.css` content replaced with minimal loading/error styles (keep the file, replace contents)

**Interfaces:**
- Consumes: `invoke("get_remembered_project")`, `invoke("choose_project_folder")`, `invoke("start_project", { folder })` (Tasks 4–5); listens for `sidecar-ready` (`{ url }`) and `sidecar-error` (`{ message }`) events (Task 5).
- Produces: the window's actual startup UI — nothing later depends on this beyond it existing.

- [ ] **Step 1: Replace the HTML**

Replace the full contents of `desktop/src/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>ISR</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main id="app">
      <p id="status">Starting ISR…</p>
      <div id="error" hidden>
        <p id="error-message"></p>
        <button id="retry">Choose a different folder</button>
      </div>
    </main>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Replace the styles**

Replace the full contents of `desktop/src/styles.css`:
```css
body {
  margin: 0;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  background: #1e1e1e;
  color: #e0e0e0;
}

#app {
  text-align: center;
}

#error-message {
  max-width: 32rem;
  white-space: pre-wrap;
  color: #e08080;
}

button {
  margin-top: 1rem;
  padding: 0.5rem 1rem;
  font-size: 1rem;
  cursor: pointer;
}
```

- [ ] **Step 3: Replace the startup script**

Replace the full contents of `desktop/src/main.js`:
```js
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const errorMessageEl = document.getElementById('error-message')
const retryButton = document.getElementById('retry')

listen('sidecar-ready', (event) => {
  window.location.replace(event.payload.url)
})

listen('sidecar-error', (event) => {
  statusEl.hidden = true
  errorEl.hidden = false
  errorMessageEl.textContent = event.payload.message
})

async function launch(folder) {
  statusEl.hidden = false
  errorEl.hidden = true
  statusEl.textContent = `Starting ISR in ${folder}…`
  await invoke('start_project', { folder })
}

async function chooseAndLaunch() {
  const folder = await invoke('choose_project_folder')
  if (folder) await launch(folder)
}

retryButton.addEventListener('click', () => {
  chooseAndLaunch()
})

async function main() {
  const remembered = await invoke('get_remembered_project')
  if (remembered) {
    await launch(remembered)
  } else {
    await chooseAndLaunch()
  }
}

main()
```

- [ ] **Step 4: Remove the now-unused template command**

If the scaffold's default `greet` command is still registered in `desktop/src-tauri/src/main.rs`'s `generate_handler!` list (kept as a placeholder since Task 4 Step 5), remove it now along with its function (likely in `main.rs` or a `lib.rs` the scaffold generated) — nothing in the new frontend calls it.

- [ ] **Step 5: Verify the full startup flow**

Run: `cd desktop && bun run tauri dev`
Expected: window opens showing "Starting ISR…", then a native folder picker (no remembered folder yet). Choose the `isr` repo itself (`~/projects/isr`). The window should then navigate to the ISR web UI — the same page you'd see opening the printed URL in a browser today. Quit the app, run `bun run tauri dev` again: it should skip the folder picker and go straight to "Starting ISR in .../isr…" then load the UI, confirming the remembered-folder store round-trips.

- [ ] **Step 6: Verify the error path**

Temporarily rename `desktop/src-tauri/binaries/isr-<your-triple>` to something else (e.g. append `.bak`), run `bun run tauri dev`, confirm the window shows the error screen with a "Choose a different folder" button rather than hanging on "Starting ISR…". Rename the binary back afterward (or re-run `bun run prepare-sidecar`).

- [ ] **Step 7: Commit**

```bash
git add desktop/src/
git commit -m "$(cat <<'EOF'
Wire the loading/error frontend to the project + sidecar commands

On launch: use the remembered project folder if there is one,
otherwise prompt for one. Listens for sidecar-ready to navigate into
the real ISR UI, and sidecar-error to show a retry screen instead of
hanging on a blank/loading window.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 7: "Open Folder…" menu item

**Files:**
- Modify: `desktop/src-tauri/src/main.rs` (add a native menu with an "Open Folder…" item, wire its click to emit a frontend-facing event)
- Modify: `desktop/src/main.js` (listen for the menu event, reuse `chooseAndLaunch`)

**Interfaces:**
- Consumes: `chooseAndLaunch()` (Task 6, unchanged) and `start_project`'s existing kill-current-then-spawn behavior (Task 5, unchanged) — switching projects is just calling the same functions again.
- Produces: emits a `"menu-open-folder"` window event when the menu item is clicked.

- [ ] **Step 1: Build the menu**

In `desktop/src-tauri/src/main.rs`, inside the `.setup(|app| { ... })` closure (add one if the scaffold didn't generate one), build and attach a menu:
```rust
use tauri::menu::{Menu, MenuItem, Submenu};

.setup(|app| {
    let open_folder = MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("Cmd+O"))?;
    let file_menu = Submenu::with_items(app, "File", true, &[&open_folder])?;
    let menu = Menu::with_items(app, &[&file_menu])?;
    app.set_menu(menu)?;
    Ok(())
})
.on_menu_event(|app, event| {
    if event.id() == "open-folder" {
        let _ = app.emit("menu-open-folder", ());
    }
})
```
Add this alongside the existing `.plugin(...)`/`.manage(...)` calls in the builder chain, before `.build(tauri::generate_context!())`.

- [ ] **Step 2: Listen for it in the frontend**

In `desktop/src/main.js`, add near the other `listen(...)` calls:
```js
listen('menu-open-folder', () => {
  chooseAndLaunch()
})
```

- [ ] **Step 3: Verify**

Run: `bun run tauri dev`, let it load a project, then use File → Open Folder… (or Cmd+O) and pick a different git repo (any repo with `.git` works — `isr status`-style commands only need that). Expected: the window returns to "Starting ISR in …" and then loads that repo's board. Check `ps aux | grep isr` shows exactly one `isr` process (the old one was killed, not leaked).

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/main.rs desktop/src/main.js
git commit -m "$(cat <<'EOF'
Add File > Open Folder… menu item for switching projects

Reuses the existing choose-folder-then-start-project flow; the
kill-current-sidecar-before-spawning behavior already in
start_project means switching never leaks the old process.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```

---

### Task 8: End-to-end verification pass

**Files:** none (verification only, against everything built in Tasks 1–7)

**Interfaces:** none — this task consumes the whole app, produces nothing new.

- [ ] **Step 1: Full `bun test` regression check**

Run (from the `isr` repo root, not `desktop/`): `bun run typecheck && bun run lint && bun test`
Expected: same pass counts as before this plan started (340+ tests passing) — confirms nothing in `src/` was touched.

- [ ] **Step 2: Fresh-launch flow**

Delete the remembered-folder store to simulate a first run: find and remove `desktop-settings.json` from the Tauri app's config directory (run `bun run tauri dev` once, then check the terminal/log output for the store's resolved path, typically under `~/Library/Application Support/<bundle-id>/`). Relaunch: confirm the folder picker appears, picking the `isr` repo leads to a working board.

- [ ] **Step 3: Crash-before-URL error path**

Repeat Task 6 Step 6 (rename the sidecar binary away) to confirm the error screen still appears correctly after all later tasks' changes, not just right after Task 6.

- [ ] **Step 4: Mid-session death**

With the app running and showing a live board, find the spawned `isr` process (`ps aux | grep isr`) and `kill` it directly. Expected: the window does not silently freeze — at minimum the WebSocket disconnects and the existing React UI's own connection-lost handling (if any) takes over; note in the commit message below what was actually observed, since the design doc flagged this as worth checking rather than a hard requirement to fix in Phase 1.

- [ ] **Step 5: Clean quit**

Quit the app normally. Run `ps aux | grep isr` — expect no output (no orphaned sidecar or agent subprocess).

- [ ] **Step 6: Commit the verification note**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
Verify Phase 1 native shell end-to-end

Ran the full bun test suite (unaffected), fresh-launch folder-picker
flow, sidecar-crash-before-url error screen, mid-session sidecar
death, and clean quit with no orphaned process. Phase 1 complete per
docs/superpowers/specs/2026-09-01-native-shell-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FUAAnC5scVv8nRQh4tAyh2
EOF
)"
```
