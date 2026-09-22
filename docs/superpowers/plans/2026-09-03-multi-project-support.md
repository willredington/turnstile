# Multi-Project Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several Turnstile projects run concurrently, each in its own native window with its own sidecar process, instead of today's one-window-one-sidecar model where opening a new folder kills whatever was running.

**Architecture:** `SidecarState` becomes a registry of sidecars keyed by window label instead of tracking one. Windows are created dynamically (not declared in `tauri.conf.json`) via a shared `window::create` helper, each pre-assigned its folder through an `initialization_script` that sets `window.__TURNSTILE_FOLDER__` before `main.js` runs — replacing the old single-value "remembered project" command. Opening a folder that's already running elsewhere focuses that window instead of spawning a duplicate. The set of open folders is persisted and every one of them gets its own window again on next launch.

**Tech Stack:** Rust + Tauri v2 (`cargo test`/`cargo build`) for all of this phase's changes; the CLI/core (`src/`) is untouched.

**Spec:** `docs/superpowers/specs/2026-09-03-multi-project-support-design.md`

## Global Constraints

- This plan is written against today's single-project baseline. It does not assume the tray + notifications plan (`docs/superpowers/plans/2026-09-03-tray-notifications.md`) has been implemented — per that spec's own "Interaction with tray + notifications" note, integrating the two is a deliberate later follow-up, not part of this plan.
- Window labels are `project-<n>`, `n` from a process-lifetime atomic counter starting at 0.
- The folder-assignment channel is `window.__TURNSTILE_FOLDER__`, set by an `initialization_script` before `main.js` runs; `null` means "show the picker."
- The persisted store key is `openProjects` (a JSON array of folder path strings) in `desktop-settings.json`, replacing today's single `lastProject` string key.
- Closing a window kills only that window's sidecar and prunes its folder from `openProjects`. Closing the *last* window quits the whole app — Tauri's own default `ExitRequested`/`Exit` behavior, left unmodified, not fought with `prevent_exit()`.
- `src/core`, `src/app`, `src/adapters/*` get zero changes.

---

### Task 1: Sidecar registry (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/state.rs` (full rewrite: single-sidecar `SidecarState` → per-label registry)

**Interfaces:**
- Produces: `SidecarState::start(&self, label: &str, folder: String, new_child: CommandChild) -> u64`, `kill(&self, label: &str) -> Option<String>`, `kill_all(&self)`, `is_current(&self, label: &str, generation: u64) -> bool`, `finish_if_current(&self, label: &str, generation: u64) -> bool`, `is_folder_open(&self, folder: &str) -> Option<String>`. Consumed by Tasks 2–5.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `desktop/src-tauri/src/state.rs` with:

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

struct Entry {
    child: Option<CommandChild>,
    generation: u64,
    folder: String,
}

/// Tracks one sidecar per open project window, keyed by window label.
#[derive(Default)]
pub struct SidecarState(Mutex<HashMap<String, Entry>>);

impl SidecarState {
    /// Starts tracking `new_child` under `label`, killing whatever was previously tracked at
    /// that label first (kill-then-store under one lock acquisition, so two racing `start`
    /// calls for the same label can never both store a child without the loser being killed —
    /// same discipline the single-sidecar version this replaces used, for the same reason).
    /// Returns the new generation for that label: 1 for a fresh label, incrementing on every
    /// subsequent `start` for the same one.
    pub fn start(&self, label: &str, folder: String, new_child: CommandChild) -> u64 {
        let mut map = self.0.lock().unwrap();
        let next_generation = match map.remove(label) {
            Some(old) => {
                if let Some(child) = old.child {
                    let _ = child.kill();
                }
                old.generation + 1
            }
            None => 1,
        };
        map.insert(
            label.to_string(),
            Entry { child: Some(new_child), generation: next_generation, folder },
        );
        next_generation
    }

    /// Kills and removes the entry tracked at `label`, if any, returning its folder. Used
    /// when that window closes, so the caller can prune the same folder from the persisted
    /// open-projects list.
    pub fn kill(&self, label: &str) -> Option<String> {
        let mut map = self.0.lock().unwrap();
        map.remove(label).map(|entry| {
            if let Some(child) = entry.child {
                let _ = child.kill();
            }
            entry.folder
        })
    }

    /// Kills every tracked sidecar and clears the registry. Used on app quit.
    pub fn kill_all(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, entry) in map.drain() {
            if let Some(child) = entry.child {
                let _ = child.kill();
            }
        }
    }

    /// True if `generation` is still the live generation for `label` — i.e. no newer `start`
    /// call for that label has superseded it.
    pub fn is_current(&self, label: &str, generation: u64) -> bool {
        let map = self.0.lock().unwrap();
        map.get(label).map(|entry| entry.generation) == Some(generation)
    }

    /// Call when a reader task's own sidecar (tagged `generation`, for `label`) terminates on
    /// its own, as opposed to being killed by a newer `start` call for that label. If
    /// `generation` is still the live one for `label`, clears the tracked child — keeping the
    /// entry itself, so the folder stays known; a crashed sidecar's window is still "open,"
    /// just erroring, and `is_folder_open` should keep finding it — and returns `true`.
    /// Otherwise a newer sidecar has since taken over that label and this returns `false`.
    pub fn finish_if_current(&self, label: &str, generation: u64) -> bool {
        let mut map = self.0.lock().unwrap();
        match map.get_mut(label) {
            Some(entry) if entry.generation == generation => {
                entry.child = None;
                true
            }
            _ => false,
        }
    }

    /// Returns the window label already running `folder`, if any. Used to detect a duplicate
    /// pick before a second sidecar is ever spawned against the same repo.
    pub fn is_folder_open(&self, folder: &str) -> Option<String> {
        let map = self.0.lock().unwrap();
        map.iter().find(|(_, entry)| entry.folder == folder).map(|(label, _)| label.clone())
    }
}

#[cfg(test)]
impl SidecarState {
    /// Test-only: inserts an entry with no real child, since `CommandChild` wraps a live OS
    /// process handle and can't be constructed in a unit test. `start`'s own process-spawning
    /// half is exercised only by the manual verification in this feature's last task; what's
    /// tested here is the registry bookkeeping, which for a fresh label is exactly "insert
    /// with generation 1" — identical to what `start` does once a real child exists.
    fn insert_for_test(&self, label: &str, folder: &str, generation: u64) {
        self.0.lock().unwrap().insert(
            label.to_string(),
            Entry { child: None, generation, folder: folder.to_string() },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_current_true_for_the_live_generation_only() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 3);

        assert!(state.is_current("a", 3));
        assert!(!state.is_current("a", 2));
        assert!(!state.is_current("missing", 3));
    }

    #[test]
    fn finish_if_current_clears_the_child_but_keeps_the_entry() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 1);

        assert!(state.finish_if_current("a", 1));
        assert_eq!(state.is_folder_open("/repo-a"), Some("a".to_string()));
    }

    #[test]
    fn finish_if_current_is_false_for_a_stale_generation() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 2);

        assert!(!state.finish_if_current("a", 1));
    }

    #[test]
    fn kill_removes_only_the_given_label_and_returns_its_folder() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 1);
        state.insert_for_test("b", "/repo-b", 1);

        assert_eq!(state.kill("a"), Some("/repo-a".to_string()));
        assert!(!state.is_current("a", 1));
        assert!(state.is_current("b", 1));
    }

    #[test]
    fn kill_on_an_untracked_label_returns_none() {
        let state = SidecarState::default();
        assert_eq!(state.kill("nope"), None);
    }

    #[test]
    fn kill_all_clears_every_label() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 1);
        state.insert_for_test("b", "/repo-b", 1);

        state.kill_all();

        assert!(!state.is_current("a", 1));
        assert!(!state.is_current("b", 1));
        assert_eq!(state.is_folder_open("/repo-a"), None);
    }

    #[test]
    fn is_folder_open_finds_the_label_for_a_matching_folder_or_none() {
        let state = SidecarState::default();
        state.insert_for_test("a", "/repo-a", 1);
        state.insert_for_test("b", "/repo-b", 1);

        assert_eq!(state.is_folder_open("/repo-b"), Some("b".to_string()));
        assert_eq!(state.is_folder_open("/repo-c"), None);
    }
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib state::`
Expected: PASS (7 tests). This won't yet compile the rest of the crate cleanly since `sidecar.rs`, `project.rs`, and `lib.rs` still call the old `replace`/`kill_current` API — that's expected and fixed in later tasks. If `cargo test` fails to build the whole crate because of those callers, run `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib state::tests -- --test-threads=1` won't help either; instead confirm just this file's logic by temporarily checking with `cargo check --manifest-path desktop/src-tauri/Cargo.toml` after Task 2 completes. For this task, it's enough to visually confirm the test code above is self-consistent (it only calls methods defined in this same file) — full-crate compilation is verified at the end of Task 5.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/state.rs
git commit -m "$(cat <<'EOF'
Turn SidecarState into a per-window-label sidecar registry

Replaces the single-sidecar Option<CommandChild> with a
HashMap<String, Entry> keyed by window label, so several projects'
sidecars can be tracked (and independently killed) at once. Adds
is_folder_open for duplicate-folder detection, kill_all for app quit,
and a test-only insert_for_test helper since CommandChild can't be
constructed in a unit test.

This leaves the rest of the crate (sidecar.rs, project.rs, lib.rs)
temporarily uncompilable against the old API — fixed over the next
few commits.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 2: Project persistence and picker (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/project.rs` (full rewrite)

**Interfaces:**
- Consumes: `SidecarState::is_folder_open` from Task 1.
- Produces: `pub fn remembered_projects(app: &AppHandle) -> Vec<String>` and `pub fn forget_open_project(app: &AppHandle, folder: &str)`, both consumed by Tasks 3 and 5. The `choose_project_folder` and `start_project` Tauri commands, consumed by `lib.rs`'s `invoke_handler` list in Task 5 and by `main.js`.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `desktop/src-tauri/src/project.rs` with:

```rust
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

use crate::state::SidecarState;

const STORE_FILE: &str = "desktop-settings.json";
const OPEN_PROJECTS_KEY: &str = "openProjects";

/// Folders persisted as currently open, restored one window per entry on next launch. A
/// folder that no longer exists on disk is dropped (and the drop is persisted) rather than
/// handed back — this phase doesn't show an error window for a stale remembered path, it
/// just quietly stops remembering it.
pub fn remembered_projects(app: &AppHandle) -> Vec<String> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    let stored: Vec<String> = store
        .get(OPEN_PROJECTS_KEY)
        .and_then(|value| value.as_array().cloned())
        .map(|entries| entries.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let existing: Vec<String> =
        stored.iter().filter(|folder| std::path::Path::new(folder).is_dir()).cloned().collect();

    if existing.len() != stored.len() {
        store.set(OPEN_PROJECTS_KEY, serde_json::json!(existing));
        let _ = store.save();
    }

    existing
}

fn add_open_project(app: &AppHandle, folder: &str) {
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    let mut projects = remembered_projects(app);
    if !projects.iter().any(|p| p == folder) {
        projects.push(folder.to_string());
        store.set(OPEN_PROJECTS_KEY, serde_json::json!(projects));
        let _ = store.save();
    }
}

/// Removes `folder` from the persisted open-projects list. Called when its window closes.
pub fn forget_open_project(app: &AppHandle, folder: &str) {
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    let projects: Vec<String> =
        remembered_projects(app).into_iter().filter(|p| p != folder).collect();
    store.set(OPEN_PROJECTS_KEY, serde_json::json!(projects));
    let _ = store.save();
}

#[tauri::command]
pub async fn choose_project_folder(app: AppHandle, window: tauri::WebviewWindow) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder()?;
    let path = folder.to_string();

    // Another window is already running this folder — a second sidecar against the same
    // repo would race on the same .turnstile state directory. Focus it and close the blank
    // window that just showed the picker (nothing was running in it yet).
    if let Some(existing_label) = app.state::<SidecarState>().is_folder_open(&path) {
        if let Some(existing) = app.get_webview_window(&existing_label) {
            let _ = existing.show();
            let _ = existing.set_focus();
        }
        let _ = window.close();
        return None;
    }

    add_open_project(&app, &path);
    Some(path)
}

#[tauri::command]
pub async fn start_project(window: tauri::WebviewWindow, folder: String) -> Result<(), String> {
    crate::sidecar::start(window, folder).await
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src-tauri/src/project.rs
git commit -m "$(cat <<'EOF'
Persist a list of open projects; detect duplicate folders

Replaces the single lastProject store key with openProjects (a list),
and adds duplicate-folder detection to choose_project_folder: picking
a folder that's already open in another window focuses that window
and closes the (still blank) one that showed the picker, instead of
spawning a second sidecar against the same repo. Removes
get_remembered_project, which no longer makes sense once there can be
more than one open project — window.rs (Task 3) assigns each window's
folder directly instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 3: Window creation helper (Rust)

**Files:**
- Create: `desktop/src-tauri/src/window.rs`

**Interfaces:**
- Consumes: `SidecarState::kill` from Task 1; `project::forget_open_project` from Task 2.
- Produces: `pub fn create(app: &AppHandle, folder: Option<&str>) -> tauri::Result<WebviewWindow>`, consumed by `lib.rs` in Task 5 (both at startup, for each remembered project, and from the "Open Folder…" menu handler).

- [ ] **Step 1: Create the file**

Create `desktop/src-tauri/src/window.rs`:

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::SidecarState;

static NEXT_LABEL: AtomicU64 = AtomicU64::new(0);

/// Creates a new project window, optionally pre-assigned to `folder` — a `None` folder shows
/// the folder picker immediately (see `main.js`, which reads `window.__TURNSTILE_FOLDER__`,
/// set below via an init script before `main.js` ever runs). Wires the window's close button
/// to kill its sidecar and prune it from the persisted open-projects list.
pub fn create(app: &AppHandle, folder: Option<&str>) -> tauri::Result<WebviewWindow> {
    let label = format!("project-{}", NEXT_LABEL.fetch_add(1, Ordering::Relaxed));
    let init_script = format!(
        "window.__TURNSTILE_FOLDER__ = {};",
        serde_json::to_string(&folder).unwrap_or_else(|_| "null".to_string())
    );

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Turnstile")
        .inner_size(800.0, 600.0)
        .initialization_script(&init_script)
        .build()?;

    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            let label = window_for_close.label();
            if let Some(folder) = window_for_close.state::<SidecarState>().kill(label) {
                crate::project::forget_open_project(window_for_close.app_handle(), &folder);
            }
        }
    });

    Ok(window)
}
```

Note: if `window_for_close.state::<SidecarState>()` or `window_for_close.app_handle()` don't resolve at compile time (Tauri's `Manager` blanket impl for `WebviewWindow` covers both in the version this project pins, but versions do shift this kind of surface), the fallback is `window_for_close.app_handle().state::<SidecarState>()` for the first and `&window_for_close.app_handle().clone()` for the second — try the direct form first; Step 2 (`cargo build`) will show immediately if a fallback is needed.

- [ ] **Step 2: Register the module and build to verify it compiles**

Modify `desktop/src-tauri/src/lib.rs`. Change:

```rust
mod project;
mod sidecar;
mod state;
```

to:

```rust
mod project;
mod sidecar;
mod state;
mod window;
```

Run: `cargo build --manifest-path desktop/src-tauri/Cargo.toml`
Expected: this alone won't yet succeed (`sidecar.rs` and `lib.rs`'s existing code still call the old `SidecarState`/`AppHandle`-based API) — confirm specifically that any errors reported are in `sidecar.rs` or `lib.rs`, not in the new `window.rs`, i.e. `window.rs` itself type-checks cleanly against `state.rs` and `project.rs`'s new signatures. Full green build is confirmed at the end of Task 5.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/window.rs desktop/src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add a shared window-creation helper for project windows

Replaces the static single "main" window with dynamically created
ones, each assigned its folder via an initialization_script rather
than a remembered-project lookup, and each wired to kill its own
sidecar and prune the persisted list on close.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 4: Per-window sidecar spawning (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/sidecar.rs` (rewrite `start()` and its supporting code; `parse_listen_url` and its tests stay unchanged)

**Interfaces:**
- Consumes: `SidecarState::start`/`is_current`/`finish_if_current` from Task 1.
- Produces: `pub async fn start(window: tauri::WebviewWindow, folder: String) -> Result<(), String>`, consumed by `project::start_project` (Task 2, already written to call it).

- [ ] **Step 1: Rewrite `start()`**

In `desktop/src-tauri/src/sidecar.rs`, leave `parse_listen_url` and its `#[cfg(test)] mod tests` block (the file's first ~36 lines) exactly as they are. Replace everything from the `use tauri::{AppHandle, Emitter, Manager};` line to the end of the file with:

```rust
use tauri::{Emitter, Manager, WebviewWindow};
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

/// Spawns a new sidecar against `folder` for `window` (killing any previously tracked one at
/// that window's label first, atomically, via `SidecarState::start`), and streams its output
/// until either a listen URL is found (emits `sidecar-ready` to `window` specifically, not
/// every window) or the process ends without one (emits `sidecar-error`, likewise scoped).
///
/// The reader task below is tagged with the generation `start` returns, and every emit (or
/// state mutation) it performs is gated on that generation still being current for this
/// window's label. Without this, a stale reader task left over from a sidecar a later
/// `start_project` call on the *same window* killed could still emit for a project the user
/// already switched away from in that window, racing nondeterministically against the new
/// sidecar's own events.
pub async fn start(window: WebviewWindow, folder: String) -> Result<(), String> {
    let label = window.label().to_string();
    let state = window.state::<SidecarState>();

    let (mut rx, child) = window
        .shell()
        .sidecar("turnstile")
        .map_err(|e| e.to_string())?
        .current_dir(&folder)
        .env("TURNSTILE_NO_BROWSER", "1")
        .spawn()
        .map_err(|e| e.to_string())?;

    let my_gen = state.start(&label, folder, child);

    let window_for_task = window.clone();
    let label_for_task = label.clone();
    tauri::async_runtime::spawn(async move {
        let state = window_for_task.state::<SidecarState>();
        let mut found_url = false;
        let mut stderr_tail = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_listen_url(&line) {
                        found_url = true;
                        if state.is_current(&label_for_task, my_gen) {
                            let _ = window_for_task.emit("sidecar-ready", SidecarReady { url });
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    let still_current = state.finish_if_current(&label_for_task, my_gen);
                    if still_current && !found_url {
                        let message = if stderr_tail.trim().is_empty() {
                            format!("turnstile exited before starting (code {:?})", payload.code)
                        } else {
                            stderr_tail.trim().to_string()
                        };
                        let _ = window_for_task.emit("sidecar-error", SidecarError { message });
                    }
                    break;
                }
                CommandEvent::Error(message) => {
                    if state.finish_if_current(&label_for_task, my_gen) {
                        let _ = window_for_task.emit("sidecar-error", SidecarError { message });
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}
```

Note: if `window.shell()` doesn't resolve (the `ShellExt` blanket impl covering `WebviewWindow` as well as `AppHandle`), the fallback is `window.app_handle().shell()` in the same spot — Step 2 will show immediately if that's needed.

- [ ] **Step 2: Run the existing `parse_listen_url` tests to confirm they're untouched**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib sidecar::`
Expected: PASS (the same 4 tests that existed before this task).

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/sidecar.rs
git commit -m "$(cat <<'EOF'
Spawn sidecars per window instead of per app

start() now takes the WebviewWindow it's spawning for, uses its
label as the SidecarState registry key, and emits sidecar-ready /
sidecar-error scoped to that window specifically rather than
app-wide, so one project's events can't reach another's window.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 5: Wire it all together (Rust + JS + config)

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs` (full rewrite of `run()`)
- Modify: `desktop/src/main.js` (read `window.__TURNSTILE_FOLDER__` instead of `get_remembered_project`/query params)
- Modify: `desktop/src-tauri/tauri.conf.json` (empty `windows` array — all windows now created dynamically)

**Interfaces:**
- Consumes: `project::remembered_projects` (Task 2), `window::create` (Task 3), `state::SidecarState::kill_all` (Task 1).
- Produces: a fully working multi-window app — this is the task where the whole crate compiles and runs end-to-end again.

- [ ] **Step 1: Rewrite `lib.rs`**

Replace the entire contents of `desktop/src-tauri/src/lib.rs` with:

```rust
mod project;
mod sidecar;
mod state;
mod window;

use tauri::menu::{Menu, MenuItem};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(state::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            project::choose_project_folder,
            project::start_project
        ])
        .setup(|app| {
            // Building the menu bar from scratch (a bare App submenu + a bare File submenu)
            // meant there was no Edit or Window submenu at all — copy/paste/cut/select-all/undo
            // had no key equivalent registered anywhere and silently didn't work in the webview.
            // `Menu::default` is Tauri's standard cross-platform template: on macOS it already
            // gives us App (with Quit), File (with Close Window), Edit (undo/redo/cut/copy/
            // paste/select-all), View, Window (minimize/close) and Help, each wired to its
            // standard key equivalent (Cmd+Q, Cmd+W, Cmd+Z, Cmd+X/C/V/A, Cmd+M, ...). Start from
            // that template and layer "Open Folder…" onto its existing File submenu instead of
            // composing the whole bar by hand — this is what keeps the Quit item (Cmd+Q) working
            // exactly as before, now for free via the template rather than a hand-built item.
            let menu = Menu::default(app.handle())?;

            let open_folder =
                MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("Cmd+O"))?;

            let file_menu = menu.items()?.into_iter().find_map(|item| {
                let submenu = item.as_submenu()?.clone();
                (submenu.text().ok()? == "File").then_some(submenu)
            });
            if let Some(file_menu) = file_menu {
                file_menu.prepend(&open_folder)?;
            }

            app.set_menu(menu)?;

            // Restore every project that was open at last quit, one window each; fall back to
            // a single blank window (folder picker) if none were open, e.g. on a fresh install.
            let remembered = project::remembered_projects(app.handle());
            if remembered.is_empty() {
                window::create(app.handle(), None)?;
            } else {
                for folder in &remembered {
                    window::create(app.handle(), Some(folder.as_str()))?;
                }
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Always additive: "Open Folder…" opens a new window rather than replacing
            // whichever window currently has focus. macOS has one shared menu bar across all
            // windows, so this needs no per-window logic.
            if event.id() == "open-folder" {
                let _ = window::create(app, None);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // `ExitRequested` covers the window-close path (a window closing when it's the
            // last one, or the whole app being told to close), but macOS's native "Quit" —
            // which is what `PredefinedMenuItem::quit` binds Cmd+Q and the App-menu item to —
            // calls straight into `NSApplication`'s `terminate:` selector. That bypasses
            // Tauri's window-close flow entirely and only ever emits `RunEvent::Exit` (never
            // `ExitRequested`), so relying on `ExitRequested` alone would leave Cmd+Q without
            // any sidecar cleanup. `kill_all()` is a no-op on an empty registry, so handling
            // both variants is safe even when a window's own close handler already cleaned up
            // its single entry moments before.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app_handle.state::<state::SidecarState>().kill_all();
            }
        });
}
```

- [ ] **Step 2: Update `main.js`**

Replace the entire contents of `desktop/src/main.js` with:

```javascript
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const errorMessageEl = document.getElementById('error-message')
const retryButton = document.getElementById('retry')

function showError(message) {
  statusEl.hidden = true
  errorEl.hidden = false
  errorMessageEl.textContent = message
}

listen('sidecar-ready', (event) => {
  window.location.replace(event.payload.url)
})

listen('sidecar-error', (event) => {
  showError(event.payload.message)
})

async function launch(folder) {
  statusEl.hidden = false
  errorEl.hidden = true
  statusEl.textContent = `Starting Turnstile in ${folder}…`
  try {
    // start_project can reject before the sidecar ever spawns (e.g. the binary is
    // missing/non-executable, or the OS refuses to launch it) — in that case the
    // async reader task that emits sidecar-error never starts, so this rejection is
    // the only signal we'll ever get. Without this catch it's an unhandled promise
    // rejection and the UI hangs on "Starting Turnstile in {folder}…" forever.
    await invoke('start_project', { folder })
  } catch (err) {
    showError(String(err))
  }
}

async function chooseAndLaunch() {
  try {
    const folder = await invoke('choose_project_folder')
    if (folder) {
      await launch(folder)
    } else {
      // Either the user cancelled the picker, or Rust detected the folder is already open
      // elsewhere and is closing this window right now — in the latter case nothing below
      // matters since the window is going away. In the former case, route through the same
      // showError() the other failure paths use so there's always a way back in via Retry.
      showError('No folder selected — choose one to continue.')
    }
  } catch (err) {
    showError(String(err))
  }
}

retryButton.addEventListener('click', () => {
  chooseAndLaunch()
})

async function main() {
  try {
    // Set by this window's initialization_script (see window.rs) before this script ever
    // runs — replaces the old single-value "remembered project" lookup, which stopped making
    // sense once more than one project window can exist at once.
    const folder = window.__TURNSTILE_FOLDER__
    if (folder) {
      await launch(folder)
    } else {
      await chooseAndLaunch()
    }
  } catch (err) {
    showError(String(err))
  }
}

main()
```

- [ ] **Step 3: Empty out the static window declaration**

Modify `desktop/src-tauri/tauri.conf.json`. Change:

```json
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "Turnstile",
        "width": 800,
        "height": 600
      }
    ],
```

to:

```json
  "app": {
    "withGlobalTauri": true,
    "windows": [],
```

- [ ] **Step 4: Build and run the full test suite**

Run: `cargo build --manifest-path desktop/src-tauri/Cargo.toml`
Expected: builds with no errors — this is the point where every task's changes compile together.

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
Expected: PASS, all tests from Tasks 1 and 4 (11 total: 7 in `state.rs`, 4 in `sidecar.rs`).

- [ ] **Step 5: Manual verification**

Run: `cd desktop && bun run tauri dev`, and confirm:
- On first launch (no `openProjects` persisted yet), one blank window shows the folder picker.
- Pick a project folder; the window launches it, same as today.
- File menu → "Open Folder…" (or Cmd+O) opens a *second*, independent window; pick a different folder there. Both windows now show their own project, both sidecars running (check via `ps`).
- Repeat "Open Folder…" a third time, but pick the *same* folder as one already open: the existing window for that folder is focused, the newly-opened blank window disappears, and no third sidecar spawns for that folder.
- Close one window (not the last): that project's sidecar process ends (check via `ps`), the other window and its sidecar are unaffected, the app keeps running.
- Quit the app (Cmd+Q) with two windows open: both sidecar processes end, no orphans.
- Relaunch the app: a window reopens for every project that was still open at quit time (i.e. not the one already closed individually above).
- With the app closed, manually delete (or rename) one of the folders still listed in `desktop-settings.json`'s `openProjects`, then relaunch: no window is created for the missing folder, and it's gone from `openProjects` after this launch (check the file directly).
- Close the very last window: the whole app exits (this is expected — see this plan's Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/lib.rs desktop/src/main.js desktop/src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
Wire up multi-project support end to end

tauri.conf.json no longer declares a static window; lib.rs creates
one per remembered project at launch (falling back to a blank picker
window when none are remembered) and one more per "Open Folder…",
via the window::create helper from a previous commit. main.js reads
its assigned folder from window.__TURNSTILE_FOLDER__ instead of the
now-removed get_remembered_project command. Quit kills every tracked
sidecar via SidecarState::kill_all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```
