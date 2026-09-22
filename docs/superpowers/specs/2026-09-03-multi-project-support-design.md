# Multi-Project Support — Design

## Context

Today the desktop shell (`desktop/`, see `2026-09-01-native-shell-design.md`) supports exactly
one project at a time: `SidecarState` holds a single `Option<CommandChild>`, `start_project`
kills whatever sidecar is currently tracked before spawning the new one
(`SidecarState::replace`), and the single `"main"` window declared in `tauri.conf.json` is
reused — "Open Folder…" navigates that same window to a different sidecar's URL, throwing
away the previous session.

This phase removes that constraint: several projects can run concurrently, each in its own
native window with its own sidecar process.

## Architecture

### Windows are dynamic, not declared

`tauri.conf.json`'s `app.windows` array drops the static `"main"` entry. All windows are
created at runtime via `tauri::WebviewWindowBuilder`, each assigned a unique label (an
incrementing counter, e.g. `project-0`, `project-1`, …) generated when the window is built.

### Folder assignment travels with the window, not through a "remembered project" lookup

Today, `main.js` calls `get_remembered_project()` on load to learn which folder to launch.
That stops making sense once there can be several windows: there's no longer one global
"the" remembered project. Instead, each window is built with its target folder already
encoded in its initial URL — `index.html?folder=<percent-encoded path>` — and `main.js` reads
`folder` from `location.search` instead of invoking a command. A window built with no
`folder` param shows the folder picker immediately, same as today's no-remembered-project
path. `get_remembered_project` is removed; `project.rs` no longer needs it.

### Sidecar state becomes a registry keyed by window label

`state.rs`'s `SidecarState` (today: `Mutex<Inner>` wrapping one `Option<CommandChild>` plus a
generation counter) becomes `Mutex<HashMap<String, Entry>>`, where:

```rust
struct Entry {
    child: Option<CommandChild>,
    generation: u64,
    folder: String,
}
```

keyed by window label. Every operation that used to act on "the" tracked child now takes a
label and acts on that label's entry:

- `start(label, folder)` — inserts a new entry for `label` (killing any prior child already
  at that label first, same kill-then-store-under-one-lock discipline the current `replace`
  uses, for the same race-safety reason documented there).
- `kill(label)` — kills and removes one entry. Used on that window's close.
- `kill_all()` — kills and removes every entry. Used on app quit (Cmd+Q / native Quit).
- `is_current(label, generation)` / `finish_if_current(label, generation)` — same generation
  gating `sidecar.rs`'s reader task already relies on, now scoped to one label instead of the
  whole struct.
- `is_folder_open(folder) -> Option<String>` — linear scan over entries returning the window
  label already running that folder, if any. Concurrent windows are always few, so no reverse
  index is needed.

`sidecar.rs`'s `start()` function gains a `label: String` parameter (the window it's spawning
for) and threads it through to every `SidecarState` call and every `emit` (see below).

### Events become per-window

`sidecar-ready` and `sidecar-error` are currently plain app-wide emits, received by whichever
window's `main.js` happens to still be listening (only one exists today). With N windows,
each must reach only its own window. Tauri's `Emitter` supports this directly —
`window.emit(event, payload)` instead of `app.emit(event, payload)` — so `sidecar.rs`'s
`start()` emits on the specific `WebviewWindow` it was called for, not the `AppHandle`.
`main.js`'s `listen(...)` calls are window-scoped by default when called from within that
window's own page, so no change is needed on the JS side beyond what already exists.

### Duplicate folders: caught in `choose_project_folder`, before a sidecar ever spawns

`project.rs`'s `choose_project_folder` command, after the native picker returns a path, checks
`SidecarState::is_folder_open(path)`. If it returns a label:

1. Focus that window (`show()` + `set_focus()`).
2. Close the window that invoked the picker (the blank, just-created window from "Open
   Folder…" — nothing was running in it yet, so there's nothing to lose).
3. Return without persisting the pick or touching `start_project`.

If the folder isn't already open, behavior is as today: persist the pick, return the path to
`main.js`, which calls `start_project` as usual. This keeps the dedup decision entirely
server-side — `main.js` never has to special-case "someone else already has this open."

### Persistence: a list of open folders, not one remembered folder

`desktop-settings.json`'s `lastProject: string` becomes `openProjects: string[]`. Writes:

- **Add**: when `choose_project_folder` persists a fresh (non-duplicate) pick — same timing
  as today's single-value write.
- **Remove**: when a window closes, its folder is removed from the list (the window→folder
  association needed for this comes from the same `SidecarState` entry used for `kill(label)`
  on close — read the folder before removing the entry).

On launch, Rust reads `openProjects` and creates one window per entry (each with its folder
pre-filled in the URL, as above), spawning that project's sidecar once each window is ready.
An empty list (fresh install, or every project was explicitly closed) falls back to a single
window with no folder param, showing the picker — matching today's fresh-install behavior.
A folder that no longer exists on disk is dropped from the list rather than shown as an
error window; this is a silent skip, not a UX surface for this phase.

### Menu: "Open Folder…" is always additive

Cmd+O creates a new blank window (no folder param) and shows the picker in it, regardless of
which window currently has focus — macOS has one shared menu bar across all windows, so this
needs no per-window menu wiring. This replaces today's `handle_open_folder`'s local-shell/
navigate branching entirely: that logic existed only because there was one window to either
still-be-on-the-shell-page or already-navigated-away; with every "Open Folder…" spawning a
fresh window, the branch has nothing left to do.

### Close and quit lifecycle

- **A window's close button**: kills only that window's sidecar (`SidecarState::kill(label)`)
  and removes its folder from `openProjects`. The app keeps running if any other window
  remains open.
- **Cmd+Q / native Quit**: kills every tracked sidecar (`SidecarState::kill_all()`) and exits,
  same as today's `ExitRequested`/`Exit` handling in `lib.rs`'s `.run(...)` closure, just
  iterating the whole registry instead of one child.
- Closing the last window quits the app — this matches Tauri's own default behavior (all
  windows closed → `ExitRequested`/`Exit` → process exit) rather than fighting it, and keeps
  this phase free of any `prevent_exit()`/`RunEvent::Reopen` machinery. Cmd+Q and "close the
  last window" both mean the same thing here. A background-survives-with-zero-windows model
  (Dock icon reopens a blank window) is deliberately not built in this phase — see below.

## Interaction with the tray + notifications design

`2026-09-03-tray-notifications-design.md` was written and planned against today's
single-window baseline: hide-to-tray hides "the" window, and a notification's click focuses
"the" window, because there's only one. This design is deliberately independent of that one —
it doesn't assume tray+notifications is implemented, and doesn't change that design's plan.

If both land, two things need revisiting at that point (not now):

- The tray's "Show/Hide Turnstile" and its `RunEvent::Reopen` handler need to pick *which*
  window, once there can be more than one hidden window at once.
- A notification needs to name which project it's about (e.g. "Turnstile — myrepo: Ready for
  your review"), and clicking it needs to focus that project's specific window rather than
  "the" window.

Neither is designed here; this is a flagged follow-up, not a decision.

## Error handling

| Situation | Behavior |
|---|---|
| A remembered folder from `openProjects` no longer exists on disk at launch | Dropped from the list silently; no window is created for it, no error surfaced. |
| The picker returns a folder already open elsewhere | Handled in `choose_project_folder` per "Duplicate folders" above — no sidecar spawned, no error either; this is the intended path, not a failure. |
| A sidecar fails to start (today's existing `sidecar-error` case) | Unchanged per-window behavior — that window shows the error screen. Other windows are unaffected. |
| App quit while several sidecars are running | `kill_all()` — every tracked child killed before the process exits, same SIGKILL rationale already documented on today's `SidecarState::replace`/`kill_current`. |

## Testing

- Rust unit tests for `SidecarState`'s new registry behavior: `start` under two different
  labels doesn't kill the other label's child; `kill(label)` only removes that label's entry;
  `kill_all()` clears everything; `is_folder_open` finds a match by folder and returns `None`
  when there isn't one; the existing generation-gating tests (`is_current`/
  `finish_if_current`) get a `label` parameter threaded through but keep their present
  coverage.
- No new TypeScript/core changes in this phase (unchanged from the native-shell boundary:
  `src/core`, `src/app`, `src/adapters/*` untouched) — no new `bun test` coverage needed.
- Everything else — actual multi-window behavior, dedup-focuses-and-closes, persisted list
  surviving a relaunch, per-window sidecar-ready/sidecar-error event scoping — is manual
  verification, consistent with how the native-shell and tray-notifications designs are
  already verified.

## Explicitly out of scope

- Any tray/notification integration — see "Interaction with the tray + notifications design"
  above; flagged as a follow-up once both exist, not designed here.
- An in-app "Recent Projects" list beyond the picker itself (e.g. a File-menu submenu of
  recently-closed projects) — `openProjects` only tracks currently-open folders, not history.
- Renaming/reordering windows, or any window-arrangement feature (tiling, "Arrange in Front",
  etc.) — plain OS-native window management is all this phase relies on.
- A cap on how many projects can be open at once — not enforced; YAGNI until it's an actual
  problem.
- Windows/Linux — this repo's desktop target remains macOS-only per the native-shell design;
  this phase doesn't change that.
