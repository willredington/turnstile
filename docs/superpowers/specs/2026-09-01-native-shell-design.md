# Native Shell (Phase 1) — Design

## Context

ISR is moving from "web app you point a browser tab at" toward a lightweight native
cockpit app — file tree, search, and light editing around the existing ACP-driven review
gate, without becoming a full IDE (no LSP, no serious authoring). This is the roadmap:

| Phase | What it adds |
|---|---|
| **1. Native shell (this doc)** | Wrap the existing UI in a native window |
| 2. File tree | Read-only browsing |
| 3. Search | Full-text + fuzzy file open |
| 4. Light editing | Edit + save |
| (backlog, unrelated) | A convenience terminal panel for the user's own commands |

Today, `isr` (`src/cli/app.ts`, `runApp`) is a composition root that: builds the adapters,
creates an ACP-driven `Session` (spawns the coding agent as a subprocess and drives it over
the Agent Client Protocol — there is no external terminal in this loop, per
`src/adapters/acp/client.ts`), starts a local server (`serveApp`, `Bun.serve` on an
ephemeral port), prints `isr: http://127.0.0.1:<port>/` to stdout, and opens that URL with
the OS `open`/`xdg-open` command — unless `ISR_NO_BROWSER=1` is set, which already
suppresses just the browser-open step while the server still starts and the URL is still
printed.

Phase 1's goal: replace the browser tab with a real native desktop window. **No functional
change** — this is packaging, so later phases build inside an app shell instead of a
browser tab.

## Architecture

A new `desktop/` directory holds a Tauri project (Rust + `tauri.conf.json`), sitting beside
the existing `src/` untouched.

1. Tauri's Rust side spawns the existing compiled binary (`dist/isr`, from the existing
   `bun run build`) as a **sidecar process**, with:
   - `cwd` set to the project directory the user picked (see below)
   - `ISR_NO_BROWSER=1` in its environment — already-supported, no core code change
2. Rust reads the sidecar's stdout line by line for the existing
   `isr: http://127.0.0.1:<port>/` line (already printed by `runApp`) and extracts the URL.
3. Once the URL is known, Tauri opens a native window (WebView) navigated to it. From then
   on the window behaves exactly like today's browser tab — same WebSocket push / HTTP pull,
   same React UI, unmodified.
4. On window close or app quit, Rust sends SIGTERM to the sidecar — the same signal the
   existing `shutdown()` handler in `app.ts` already handles.
5. If the sidecar exits unexpectedly, before or after the window opens, the window shows a
   native error state (sidecar's stderr, plus a log file path) instead of a blank WebView.

### What does NOT change

- `src/core`, `src/app`, `src/adapters/*` — zero changes. The ports-and-adapters boundary
  already isolates "how the UI is delivered" behind `adapters/web`; Tauri is a new consumer
  of the same HTTP/WS surface, not a new adapter.
- The React UI (`adapters/web/ui/*`) — zero changes. It doesn't know or care whether it's
  rendered in Chrome or a Tauri WebView.
- The ACP session / agent-spawning logic — zero changes.

## Choosing a project directory

ISR's CLI always operates on `process.cwd()`. A native app has no shell cwd to inherit, so
Phase 1 needs a minimal "pick a folder" flow:

- On launch, if no project is remembered, show a native "Open Folder" dialog (Tauri's
  `dialog` plugin).
- Remember the last-opened folder in Tauri's own local app config (not `.isr/`), so
  relaunching goes straight back in.
- A "File > Open Folder…" menu item switches projects: kill the current sidecar, spawn a
  new one against the new cwd, navigate the window to the new URL.

**Out of scope for Phase 1:** multiple projects open at once. One window, one project, at a
time — matches today's one-`isr`-process-per-repo model. Multi-project support is a
plausible later addition, not decided here.

## Packaging & distribution

- `desktop/` gets a `bun run build:desktop` that first runs the existing `bun run build`
  (producing `dist/isr`), bundles it as the Tauri sidecar binary, then produces the native
  app bundle.
- Target platform for Phase 1: macOS only (the current dev platform). Other platforms are
  deferred, not designed against yet.
- Desktop app version tracks the `isr` package version for now — single repo, single
  release cadence; revisit only if they ever need to diverge.

## Error handling

| Situation | Behavior |
|---|---|
| Sidecar binary missing or fails to spawn | Native error screen naming the failure — never a blank window |
| Sidecar exits before printing a URL (e.g. not a git repo, missing API key) | Surface the sidecar's stderr in the error screen — the same message CLI users see today |
| Sidecar dies mid-session | Window shows a clear "agent process exited" state rather than a silently frozen UI |
| User quits the app or closes the window | SIGTERM to the sidecar, same shutdown path as Ctrl-C today; verified no orphaned process remains |

## Testing

This phase is packaging, not new business logic — there's no new core behavior to unit
test. Verification is manual:

- Launch the app, pick a repo, confirm the window shows the same behavior as
  `bun src/cli/main.ts` + a browser today.
- Kill the sidecar process externally; confirm the app surfaces a clear error instead of
  hanging or showing a blank window.
- Quit the app; confirm no orphaned `isr` or agent subprocess remains.
- Switch projects via "Open Folder…"; confirm the old sidecar is gone and the new one is
  serving the new repo.

No changes to the existing `bun test` suite (340+ tests) are expected. `desktop/` is a
separate Rust project; it gets its own (likely minimal) tests as it grows, not covered by
`bun test`.

## Explicitly out of scope for Phase 1

- File tree, search, editing (Phases 2–4).
- Multiple concurrent project windows.
- Auto-update.
- Non-macOS builds.
- Any terminal panel — separate, unrelated, not currently planned.
