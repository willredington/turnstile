# System Tray + Notifications — Design

## Context

Today the desktop shell (`desktop/`, see `2026-09-01-native-shell-design.md`) is a thin
Tauri wrapper: it spawns the compiled `turnstile` binary as a sidecar, navigates the window
to the URL it prints, and has no presence once the window isn't the active focus. Closing
the window or quitting kills the sidecar (`SidecarState::kill_current`, wired to both
`RunEvent::ExitRequested` and `RunEvent::Exit` in `lib.rs`).

That means a session running in the background gives no signal when the agent finishes a
turn and a review is waiting — the whole point of automating a coding agent is to be able to
walk away, but today walking away means missing the moment it needs you back.

This phase adds a system tray icon and native notifications so Turnstile can live in the
background and surface exactly one signal: **a review is ready for you**.

## Architecture

- New Rust module `desktop/src-tauri/src/tray.rs`, registered from `lib.rs`.
- New Cargo dependency: `tauri-plugin-notification = "2"`. The tray icon itself is part of
  Tauri v2's core (`tauri::tray::TrayIconBuilder`) — no separate plugin needed for that half.
- New capability: add `notification:default` to `desktop/src-tauri/capabilities/default.json`
  alongside the existing `core:default` / `opener:default`.
- No changes to `src/core`, `src/adapters/web`, or the React UI, with one exception: a single
  new stdout line written from `src/app/session.ts` (see below) — everything else is
  desktop-shell-only, matching the boundary the native-shell design already established.

## Components & data flow

1. **Tray icon** (`tray.rs`, built in `.setup()`): a menu with, in order, "Show/Hide
   Turnstile", "Open Folder…", a separator, and "Quit". Left-clicking the tray icon itself
   toggles the main window's visibility (same action as the menu's "Show/Hide" item).
   "Open Folder…" reuses the existing `menu-open-folder` event / `chooseAndLaunch()` flow
   already wired for the File menu's "Open Folder…" item in `lib.rs`.

2. **Window close hides instead of quitting** (`lib.rs`): a `WindowEvent::CloseRequested`
   handler on the main window calls `api.prevent_close()` then `window.hide()`. The sidecar
   keeps running. The only paths that actually exit the app are the tray's "Quit" item and
   Cmd+Q / native Quit — both already funnel into the existing `RunEvent::ExitRequested` /
   `RunEvent::Exit` handling in `lib.rs`, which calls `SidecarState::kill_current()` before
   the process exits. Tray "Quit" additionally calls `app_handle.exit(0)` explicitly, since
   with `prevent_close()` in place, closing the last window no longer triggers exit on its
   own.

3. **Notify line** (`sidecar.rs`): alongside the existing `parse_listen_url`, add
   `parse_notify_line`, which strips a `turnstile:notify: ` prefix from a stdout line. It's
   checked in the same `CommandEvent::Stdout` match arm, gated by the same
   `state.is_current(my_gen)` check `sidecar-ready` already uses (so a stale sidecar from a
   project the user already switched away from can't fire a notification). On match, it
   calls `tauri_plugin_notification`'s `app.notification().builder().title("Turnstile").body(msg).show()`.

4. **CLI-side emit** (`src/app/session.ts`): at the existing call site where `broadcast(state)`
   fires after computing `waitingOn(status, reviewOpen)`, track the previous tick's `.on`
   value. When it **transitions** into `'you'` (not on every subsequent broadcast while it
   stays `'you'`), write `process.stdout.write('turnstile:notify: Ready for your review\n')`.
   Edge-triggered, not level-triggered — otherwise every state tick while a review sits open
   would re-fire a notification.

5. **Clicking a notification** re-shows and focuses the main window. There's exactly one
   sidecar at a time in the current single-project model, so there's no ambiguity about
   which project's window to show — this gets revisited if/when multi-project support (a
   separate, later design) lands.

## Error handling

- A failed `show()` call (e.g. OS notification permission denied) is logged and ignored via
  the same `let _ =` pattern already used elsewhere in `sidecar.rs` — a missed notification
  isn't fatal to the session.
- A `turnstile:notify:` line arriving for a stale generation (the sidecar was replaced by a
  later `start_project` call) is dropped, same as a stale `sidecar-ready` today.
- No special first-run notification-permission UX is planned; this relies on the OS/plugin's
  default prompt behavior.

## Testing

- Rust unit tests for `parse_notify_line`, mirroring the existing `parse_listen_url` tests in
  `sidecar.rs` (extracts the message, strips trailing CR/LF, ignores unrelated lines, ignores
  near-miss prefixes).
- TypeScript unit test for the edge-triggered emit in `session.ts` (fires once on the
  transition into `on === 'you'`, does not refire on subsequent broadcasts while still
  `'you'`, does not fire when never reaching `'you'`).
- Everything else — actual OS notification delivery, tray menu behavior, hide/show/quit
  lifecycle — is manual verification only, consistent with how `sidecar-ready` /
  `sidecar-error` are already verified today (this phase adds no new automated e2e coverage
  for native OS chrome, which isn't testable headlessly).

## Explicitly out of scope

- Notifying on sidecar crash/error or on "agent went idle with nothing pending" — considered
  and deliberately deferred; only the "review ready" signal is in scope for this phase.
- Multi-project support / multiple tray-tracked sessions — separate design.
- macOS-only "menu-bar accessory" mode (hiding the Dock icon while backgrounded) — the app
  keeps its normal Dock presence at all times; only explicit Quit exits it.
- Notification click deep-linking to a specific review/chunk — clicking just shows the
  window; the window already shows the right board.
- Windows/Linux tray icon assets and platform-specific packaging — this repo's desktop
  target remains macOS-only per the native-shell design; this phase doesn't change that.
