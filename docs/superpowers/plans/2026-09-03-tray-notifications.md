# System Tray + Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS system tray icon and a native "review ready" notification to the Turnstile desktop shell, with closing the window hiding it (sidecar keeps running) instead of quitting.

**Architecture:** The CLI edge-detects the moment a review becomes ready (`waitingOn(...).on === 'you'`) and writes one new `turnstile:notify: <message>` stdout line, reusing the existing `turnstile: <url>` line convention the desktop shell already parses. The Rust sidecar reader picks up that line and shows a native notification via `tauri-plugin-notification`. A new tray icon (Tauri v2 core `tray-icon` feature) gets a Show/Hide/Open Folder/Quit menu, and the main window's close button hides it instead of destroying it — only tray "Quit" (and Cmd+Q, already wired) actually exits and kills the sidecar.

**Tech Stack:** Bun/TypeScript (`bun:test`) for the CLI-side notifier; Rust + Tauri v2 (`cargo test`) for the desktop shell; `tauri-plugin-notification` for OS notifications.

**Spec:** `docs/superpowers/specs/2026-09-03-tray-notifications-design.md`

## Global Constraints

- The stdout notify-line prefix is exactly `turnstile:notify: ` (colon, no space before it, one space after) — Rust parses this literally.
- The notification body text for this phase is exactly `Ready for your review`; the notification title is `Turnstile`.
- Only the "review ready for you" transition triggers a notification in this phase — not sidecar crashes, not "agent went idle." (Per spec's "Explicitly out of scope.")
- Desktop target stays macOS-only (per the existing native-shell design) — no Windows/Linux tray asset or packaging work.
- The app keeps its normal Dock icon at all times; no macOS activation-policy toggling.
- `src/app/session.ts` and `src/core/*` get zero changes — the notify decision is composition-root-only code (`src/cli/*`), consistent with `session.ts`'s existing "owns no I/O of its own" boundary.

---

### Task 1: Review-ready notifier (TypeScript)

**Files:**
- Create: `src/cli/notify.ts`
- Create: `tests/cli/notify.test.ts`
- Modify: `src/cli/app.ts:66-92` (the `onChange` wiring inside `runApp()`)

**Interfaces:**
- Produces: `createReviewReadyNotifier(write: (line: string) => void): (state: SessionState) => void` — a factory that returns a function to call on every session state change. It calls `write('turnstile:notify: Ready for your review\n')` exactly once per transition into "review ready," using `waitingOn` from `src/core/waiting.ts` (already exists, unmodified) and `state.review !== null` as the `reviewOpen` argument, exactly like `src/adapters/web/ui/App.tsx:129` already does client-side.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/notify.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import { createReviewReadyNotifier } from '../../src/cli/notify.ts'
import type { ReviewState, SessionState } from '../../src/core/types.ts'

const BASE: SessionState = {
  status: 'starting',
  sessionId: 's1',
  transcript: [],
  permissions: [],
  revision: 0,
  diffRevision: 0,
  review: null,
  chunks: [],
  history: [],
  activeChunk: null,
  annotations: [],
  queued: [],
}

const OPEN_REVIEW = {} as unknown as ReviewState

describe('review-ready notifier', () => {
  test('writes once when the review transitions to ready', () => {
    const lines: string[] = []
    const notify = createReviewReadyNotifier((line) => lines.push(line))

    notify({ ...BASE, status: 'working', review: null })
    notify({ ...BASE, status: 'reviewing', review: null })
    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })

    expect(lines).toEqual(['turnstile:notify: Ready for your review\n'])
  })

  test('does not refire on further state changes while the review stays ready', () => {
    const lines: string[] = []
    const notify = createReviewReadyNotifier((line) => lines.push(line))

    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })
    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })
    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })

    expect(lines.length).toBe(1)
  })

  test('never writes if the review is never ready', () => {
    const lines: string[] = []
    const notify = createReviewReadyNotifier((line) => lines.push(line))

    notify({ ...BASE, status: 'starting', review: null })
    notify({ ...BASE, status: 'working', review: null })
    notify({ ...BASE, status: 'reviewing', review: null })
    notify({ ...BASE, status: 'idle', review: null })

    expect(lines).toEqual([])
  })

  test('fires again on a second transition after review closes and reopens', () => {
    const lines: string[] = []
    const notify = createReviewReadyNotifier((line) => lines.push(line))

    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })
    notify({ ...BASE, status: 'working', review: null })
    notify({ ...BASE, status: 'reviewing', review: OPEN_REVIEW })

    expect(lines.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli/notify.test.ts`
Expected: FAIL — `src/cli/notify.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement the notifier**

Create `src/cli/notify.ts`:

```typescript
import type { SessionState } from '../core/types.ts'
import { waitingOn } from '../core/waiting.ts'

/**
 * Watches a stream of session states and calls `write` exactly once each time a review
 * transitions into being ready for the user — not on every subsequent state change while it
 * stays ready, and not at all if it never reaches that point.
 */
export function createReviewReadyNotifier(
  write: (line: string) => void,
): (state: SessionState) => void {
  let wasReady = false

  return (state: SessionState): void => {
    const isReady = waitingOn(state.status, state.review !== null).on === 'you'
    if (isReady && !wasReady) {
      write('turnstile:notify: Ready for your review\n')
    }
    wasReady = isReady
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/notify.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire the notifier into the composition root**

Modify `src/cli/app.ts`. Add the import near the top with the other local imports:

```typescript
import { createReviewReadyNotifier } from './notify.ts'
```

Inside `runApp()`, before `const session: Session = createSession({...})` (currently starting at line 68), add:

```typescript
  const notifyReviewReady = createReviewReadyNotifier((line) => process.stdout.write(line))
```

Then change the `onChange` field (currently `onChange: (state) => broadcast(state as never),`) to:

```typescript
    onChange: (state) => {
      notifyReviewReady(state)
      broadcast(state as never)
    },
```

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `bun run typecheck && bun test`
Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/cli/notify.ts tests/cli/notify.test.ts src/cli/app.ts
git commit -m "$(cat <<'EOF'
Emit a turnstile:notify stdout line when a review becomes ready

Edge-triggered on the transition into waitingOn(...).on === 'you', so
a desktop shell watching the sidecar's stdout can fire a native
notification without polling or duplicating the waiting.ts logic.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 2: Parse the notify line (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/sidecar.rs:1-36` (add `parse_notify_line` beside `parse_listen_url`, with its own tests)

**Interfaces:**
- Consumes: the `turnstile:notify: <message>\n` stdout line produced by Task 1's `createReviewReadyNotifier`.
- Produces: `pub fn parse_notify_line(line: &str) -> Option<String>` — used by Task 3 inside `start()`'s stdout match arm.

- [ ] **Step 1: Write the failing tests**

In `desktop/src-tauri/src/sidecar.rs`, add to the existing `#[cfg(test)] mod tests` block (after the existing four tests, before the closing `}` at line 36):

```rust
    #[test]
    fn extracts_message_from_the_turnstile_notify_line() {
        assert_eq!(
            parse_notify_line("turnstile:notify: Ready for your review"),
            Some("Ready for your review".to_string())
        );
    }

    #[test]
    fn notify_line_strips_trailing_newline_or_carriage_return() {
        assert_eq!(
            parse_notify_line("turnstile:notify: Ready for your review\r\n"),
            Some("Ready for your review".to_string())
        );
    }

    #[test]
    fn notify_line_ignores_unrelated_stdout_lines() {
        assert_eq!(parse_notify_line("some other log line"), None);
        assert_eq!(parse_notify_line(""), None);
    }

    #[test]
    fn notify_line_ignores_the_listen_url_line() {
        assert_eq!(parse_notify_line("turnstile: http://127.0.0.1:54321/"), None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml notify`
Expected: FAIL to compile — `parse_notify_line` is not defined.

- [ ] **Step 3: Implement `parse_notify_line`**

In `desktop/src-tauri/src/sidecar.rs`, add this function directly after `parse_listen_url` (currently lines 1–4):

```rust
pub fn parse_notify_line(line: &str) -> Option<String> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    trimmed.strip_prefix("turnstile:notify: ").map(|msg| msg.to_string())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml notify`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/sidecar.rs
git commit -m "$(cat <<'EOF'
Add parse_notify_line for the turnstile:notify stdout convention

Mirrors the existing parse_listen_url pattern used for the
turnstile: <url> handshake line.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 3: Wire native notifications

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (add `tauri-plugin-notification` dependency)
- Modify: `desktop/src-tauri/capabilities/default.json` (grant the `notification:default` permission)
- Modify: `desktop/src-tauri/src/lib.rs:19-22` (register the plugin)
- Modify: `desktop/src-tauri/src/sidecar.rs` (call the notification builder when `parse_notify_line` matches)

**Interfaces:**
- Consumes: `parse_notify_line` from Task 2.
- Produces: a running desktop app that shows a native "Turnstile / Ready for your review" notification when the sidecar prints the notify line. Nothing downstream depends on this beyond manual verification — there is no automated coverage for actual OS notification delivery (per spec).

- [ ] **Step 1: Add the dependency**

Run: `cargo add --manifest-path desktop/src-tauri/Cargo.toml tauri-plugin-notification@2`

This adds a `tauri-plugin-notification = "2..."` line to `desktop/src-tauri/Cargo.toml`'s `[dependencies]` and updates `Cargo.lock`.

- [ ] **Step 2: Grant the capability**

Modify `desktop/src-tauri/capabilities/default.json`. Change:

```json
  "permissions": ["core:default", "opener:default"]
```

to:

```json
  "permissions": ["core:default", "opener:default", "notification:default"]
```

- [ ] **Step 3: Register the plugin**

Modify `desktop/src-tauri/src/lib.rs`. Change (lines 18–22):

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
```

to:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 4: Show the notification when the notify line arrives**

Modify `desktop/src-tauri/src/sidecar.rs`. Add the import near the top, alongside the existing `use` lines:

```rust
use tauri_plugin_notification::NotificationExt;
```

In the `CommandEvent::Stdout` match arm inside `start()` (currently):

```rust
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_listen_url(&line) {
                        found_url = true;
                        if state.is_current(my_gen) {
                            let _ = app_for_task.emit("sidecar-ready", SidecarReady { url });
                        }
                    }
                }
```

change to:

```rust
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_listen_url(&line) {
                        found_url = true;
                        if state.is_current(my_gen) {
                            let _ = app_for_task.emit("sidecar-ready", SidecarReady { url });
                        }
                    } else if let Some(message) = parse_notify_line(&line) {
                        if state.is_current(my_gen) {
                            let _ = app_for_task
                                .notification()
                                .builder()
                                .title("Turnstile")
                                .body(message)
                                .show();
                        }
                    }
                }
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cargo build --manifest-path desktop/src-tauri/Cargo.toml`
Expected: builds with no errors.

- [ ] **Step 6: Run the full Rust test suite**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
  desktop/src-tauri/capabilities/default.json desktop/src-tauri/src/lib.rs \
  desktop/src-tauri/src/sidecar.rs
git commit -m "$(cat <<'EOF'
Show a native notification when a review becomes ready

Wires tauri-plugin-notification and reacts to the turnstile:notify
stdout line added in the previous commit, gated by the same
generation check sidecar-ready already uses so a stale sidecar can't
notify for a project the user already switched away from.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```

---

### Task 4: Tray icon, menu, and hide-to-tray window lifecycle

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (enable the `tray-icon` feature on the `tauri` dependency)
- Create: `desktop/src-tauri/src/tray.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (register `tray` module, extract `handle_open_folder`, add close-hides-window behavior, build the tray in `.setup()`)

**Interfaces:**
- Consumes: nothing from Tasks 1–3 (independent of the notify pipeline; both land in the same running app).
- Produces: `pub(crate) fn handle_open_folder(app: &tauri::AppHandle)` in `lib.rs`, called from both the existing File-menu handler and the new tray menu — the single place the "am I on the local shell page or an already-loaded board" logic lives, so tray and File menu can't drift apart.

Note: this task also covers the spec's "clicking a notification re-shows and focuses the main window" requirement, via the same OS reactivation path a Dock-icon click uses (see Step 6) rather than a notification-specific callback — see that step for why.

- [ ] **Step 1: Enable the tray-icon Cargo feature**

Run: `cargo add --manifest-path desktop/src-tauri/Cargo.toml tauri --features tray-icon`

This merges `tray-icon` into the existing `tauri = { version = "2", features = [...] }` line without changing the version requirement.

- [ ] **Step 2: Extract `handle_open_folder` in `lib.rs`**

Modify `desktop/src-tauri/src/lib.rs`. Change the existing `.on_menu_event` block:

```rust
        .on_menu_event(|app, event| {
            if event.id() != "open-folder" {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };

            // main.js's `listen('menu-open-folder', ...)` only exists on the local shell page
            // (index.html + main.js). Once `sidecar-ready` fires, that page's own
            // `window.location.replace(url)` navigates the window to the sidecar's served UI —
            // a completely different document — which unloads main.js and, with it, that
            // listener. A plain `emit` at that point reaches nobody. So: if we're still on the
            // local shell page, emit as normal and let the existing listener reuse
            // `chooseAndLaunch()`. If we've already navigated to a project's board, bring the
            // window back to the local shell page first (with a marker query param), so
            // main.js reloads fresh, re-registers its listeners, and — per the check added to
            // `main()` — opens the folder picker immediately instead of relaunching the
            // remembered project. Without this branch "Open Folder…" would silently do nothing
            // once a project was already loaded, which is the main scenario this menu item
            // exists for.
            let is_on_local_shell = match (window.url().ok(), APP_URL.get()) {
                (Some(mut current), Some(base)) => {
                    current.set_query(None);
                    &current == base
                }
                _ => false,
            };

            if is_on_local_shell {
                let _ = app.emit("menu-open-folder", ());
            } else if let Some(base) = APP_URL.get() {
                let mut url = base.clone();
                url.set_query(Some("openFolder=1"));
                let _ = window.navigate(url);
            }
        })
```

to:

```rust
        .on_menu_event(|app, event| {
            if event.id() == "open-folder" {
                handle_open_folder(app);
            }
        })
```

Then add `handle_open_folder` as its own function, placed after `run()` (i.e. after the closing brace of `pub fn run() { ... }`, before end of file):

```rust
/// Brings the app to a state where the user can pick a new project folder — reused by both
/// the File menu's "Open Folder…" item and the tray menu's equivalent, so the "am I still on
/// the local shell page or already showing a project's board" branch lives in exactly one
/// place. See the (moved) comment above for why the branch exists.
pub(crate) fn handle_open_folder(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // Surfaces the window if the tray hid it — harmless no-op when it's already visible.
    let _ = window.show();
    let _ = window.set_focus();

    let is_on_local_shell = match (window.url().ok(), APP_URL.get()) {
        (Some(mut current), Some(base)) => {
            current.set_query(None);
            &current == base
        }
        _ => false,
    };

    if is_on_local_shell {
        let _ = app.emit("menu-open-folder", ());
    } else if let Some(base) = APP_URL.get() {
        let mut url = base.clone();
        url.set_query(Some("openFolder=1"));
        let _ = window.navigate(url);
    }
}
```

- [ ] **Step 3: Add the module declaration**

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
mod tray;
```

- [ ] **Step 4: Hide instead of close, and build the tray, in `.setup()`**

Modify `desktop/src-tauri/src/lib.rs`. Change the `.setup()` closure's window block (currently):

```rust
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    let _ = APP_URL.set(url);
                }
            }

            Ok(())
        })
```

to:

```rust
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    let _ = APP_URL.set(url);
                }

                // Closing the window hides it instead of destroying it, so the sidecar keeps
                // running in the background — only tray "Quit" (and Cmd+Q, handled below in
                // `.run()`) actually exits and kills it.
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            tray::build(app.handle())?;

            Ok(())
        })
```

- [ ] **Step 5: Create the tray module**

Create `desktop/src-tauri/src/tray.rs`:

```rust
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// Builds the tray icon and wires its menu and click behavior. Called once from `.setup()`.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show_hide =
        MenuItem::with_id(app, "toggle-window", "Show/Hide Turnstile", true, None::<&str>)?;
    let open_folder =
        MenuItem::with_id(app, "tray-open-folder", "Open Folder…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show_hide, &open_folder, &separator, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id();
            if id == "toggle-window" {
                toggle_main_window(app);
            } else if id == "tray-open-folder" {
                crate::handle_open_folder(app);
            } else if id == "tray-quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 6: Reopen the window on Dock-icon click / OS reactivation with no visible window**

With the Dock icon staying visible at all times (per the design decision) but the window now hideable, clicking the Dock icon needs to bring the window back — this is the standard macOS "reopen" path (`RunEvent::Reopen`), and it's also the same app-reactivation path the OS uses when a native notification banner is clicked, since a notification click first activates the sending app. There's no dedicated per-notification click callback wired here; this one handler covers both cases.

Modify `desktop/src-tauri/src/lib.rs`. Change the `.run(...)` closure (currently):

```rust
        .run(|app_handle, event| {
            // `ExitRequested` covers the window-close path (red traffic-light button /
            // last-window-destroyed), but macOS's native "Quit" — which is what
            // `PredefinedMenuItem::quit` binds Cmd+Q and the App-menu item to — calls
            // straight into `NSApplication`'s `terminate:` selector. That bypasses Tauri's
            // window-close flow entirely and only ever emits `RunEvent::Exit` (never
            // `ExitRequested`), so relying on `ExitRequested` alone left Cmd+Q without any
            // sidecar cleanup, orphaning it. `kill_current()` is idempotent (a no-op once
            // the child is already cleared), so handling both variants is safe even though
            // the window-close path fires them back-to-back.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app_handle.state::<state::SidecarState>().kill_current();
            }
        });
```

to:

```rust
        .run(|app_handle, event| {
            // `ExitRequested` covers the window-close path (red traffic-light button /
            // last-window-destroyed), but macOS's native "Quit" — which is what
            // `PredefinedMenuItem::quit` binds Cmd+Q and the App-menu item to — calls
            // straight into `NSApplication`'s `terminate:` selector. That bypasses Tauri's
            // window-close flow entirely and only ever emits `RunEvent::Exit` (never
            // `ExitRequested`), so relying on `ExitRequested` alone left Cmd+Q without any
            // sidecar cleanup, orphaning it. `kill_current()` is idempotent (a no-op once
            // the child is already cleared), so handling both variants is safe even though
            // the window-close path fires them back-to-back.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app_handle.state::<state::SidecarState>().kill_current();
            }

            // Fires on Dock-icon click (or native-notification click, which activates the
            // app via the same Cocoa path) while no window is visible — exactly the state
            // `CloseRequested`'s `hide()` leaves the app in. Without this there'd be no way
            // back in except the tray menu.
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
```

- [ ] **Step 7: Make the tray's "Quit" actually exit and kill the sidecar**

`app.exit(0)` in Step 5 triggers Tauri's `RunEvent::Exit`, which the `.run(...)` closure above already matches and already calls `app_handle.state::<state::SidecarState>().kill_current()` for — no further change needed for that half.

- [ ] **Step 8: Build to verify it compiles**

Run: `cargo build --manifest-path desktop/src-tauri/Cargo.toml`
Expected: builds with no errors.

- [ ] **Step 9: Run the full Rust test suite**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
Expected: PASS, no regressions (no new automated tests in this task — tray/lifecycle behavior is manual per the spec).

- [ ] **Step 10: Manual verification**

Run: `bun run --cwd desktop tauri dev` (or `cd desktop && bun run tauri dev`) and, against a real project folder, confirm:
- A tray icon appears; its menu shows Show/Hide Turnstile, Open Folder…, a separator, and Quit.
- Left-clicking the tray icon toggles the main window's visibility.
- Clicking the window's close button hides it (Dock icon stays visible, sidecar process — check via `ps`/Activity Monitor — keeps running).
- Clicking the Dock icon while the window is hidden re-shows and focuses it.
- Tray "Open Folder…" while the window is hidden shows the window again and opens the folder picker (or, if a project is already loaded, returns to the local shell page and opens the picker — same as the existing File-menu behavior).
- Tray "Quit" exits the app and the sidecar process is gone (no orphan).
- Driving a real session to the point a review opens fires a native "Turnstile / Ready for your review" notification (end-to-end check of Tasks 1–3 together with this task's window/tray plumbing) — and clicking that notification re-shows/focuses the window. If it doesn't reliably do so on the test machine's macOS version, note it as a known follow-up rather than blocking on it — there's no dedicated per-notification click API wired here, only the shared reactivation path.

- [ ] **Step 11: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
  desktop/src-tauri/src/tray.rs desktop/src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add tray icon and hide-to-tray window lifecycle

Closing the window now hides it instead of quitting, so the sidecar
keeps running in the background; only the tray's Quit item (and
Cmd+Q, already wired) actually exits. The tray's Open Folder… reuses
the same handle_open_folder logic as the File menu, extracted here so
the two can't drift apart.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RyMQJDisLPb1ijBbBB9PEB
EOF
)"
```
