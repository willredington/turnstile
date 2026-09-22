# Read-Only File Explorer — Design

## Context

ISR's UI today has no way to browse the project at all outside of what a review touches.
`ChunkList` only ever shows files that have chunks on the board — decided or not — and
`App.tsx`'s detail panel only ever renders a diff (`ChunkView`) for a selected chunk. There
is no way to look at a file that hasn't changed, which matters most exactly when reviewing:
understanding a diff often means seeing the surrounding code it doesn't show.

This spec adds a VS Code Explorer–style file tree: a standalone panel that lists every file
in the project (respecting `.gitignore`), lets you expand/collapse folders freely, and opens
a file's current contents read-only when clicked. It is explicitly **not** related to the
board — no chunk selection, no diff, no verdicts. Two separate concerns that happen to both
touch the filesystem.

### Naming clash this spec also fixes

`core/ports.ts` already has a `Workspace` port (`read`/`write`), used only by
`session.ts`'s `regionOf`/`applyEdit` to read and write the exact region a human hand-typed
edit targets. Its own doc comment says it's "deliberately tiny... should not grow into a
filesystem." Introducing a second, broader, read-only filesystem port (`ProjectTree`) right
next to a port named `Workspace` would make the two impossible to tell apart by name alone.
This spec renames `Workspace` → **`EditTarget`**, which is what it actually is: the file a
typed edit is read from and written to. `ProjectTree` stays free to mean what it sounds
like it means.

## Goals

- Browse the full project tree — every file, not just changed ones — independent of the
  review board.
- Whole tree available after one fetch; expand/collapse is instant client-side state, not a
  round-trip per folder click.
- Correctly respects `.gitignore`, including nested ones, without hand-rolling ignore-pattern
  parsing.
- Click a file, see its current on-disk contents, read-only.
- Rename `Workspace` → `EditTarget` so the two filesystem-touching ports are named for what
  they actually do.

## Non-goals (explicitly out of scope for this spec)

- **Editing from the tree.** Confirmed with the user: read-only for now. No write endpoint,
  no editable viewer.
- **Syntax highlighting.** The viewer renders plain text. A later spec can add it.
- **Binary file handling.** Content is read as UTF-8 text; a binary file renders whatever
  `Bun.file().text()` produces. Not addressed here.
- **Lazy per-directory fetching.** Considered and rejected in favor of one flat fetch — see
  Architecture. Revisit only if a real repo's file count makes the flat list too slow, which
  is not expected for this tool's typical targets.
- **Live filesystem watching.** The tree refetches on the same `diffRevision` signal the diff
  pane already uses (see Data flow), not on a dedicated file-watcher push.

## Architecture

### `ProjectTree`, a new port

```ts
export interface ProjectTree {
  /** Every non-ignored file path in the project, relative to the repo root, forward-slash
   *  separated. Directories are implied by path segments, not listed separately. */
  list(): Promise<string[]>
  /** A file's current contents, or null if it doesn't exist / can't be read / resolves
   *  outside the project root. */
  read(path: string): Promise<string | null>
}
```

Implemented in `adapters/fs/projectTree.ts`:

- `list()` uses `globby(['**/*'], { gitignore: true, cwd, onlyFiles: true, ignore: ['.git'] })`.
  `globby`'s `gitignore` option discovers and applies every `.gitignore` in the tree
  (including nested ones), which a single `git ls-files` call was considered for and rejected
  — reaching for git here would make file browsing depend on git-repo internals for something
  that is really just "walk a directory," and `globby` is the standard tool in this ecosystem
  for exactly this job. `globby` is a new dependency; nothing else in the repo currently walks
  the filesystem directly.
- `read()` resolves the path against the project root and rejects traversal exactly the way
  `createFileWorkspace`'s existing `resolve()` does (`join` + prefix check) — that guard logic
  is factored into a small shared helper, `adapters/fs/safePath.ts`, so both
  `EditTarget` and `ProjectTree` use the same traversal check rather than two copies of
  security-relevant logic. Reads via `Bun.file(...).text()`, same pattern as `EditTarget`.

`ProjectTree` deliberately does **not** reuse `EditTarget.read` even though the signatures
would match — see "Naming clash" above. Keeping it a self-contained two-method port means
the file-browsing vertical (port, adapter, endpoints, UI) has nothing to do with the
typed-edit vertical beyond sharing the traversal-guard helper.

### `Workspace` → `EditTarget` rename

Mechanical rename, no behavior change:

- `core/ports.ts`: interface renamed, doc comment kept as-is (still accurate).
- `adapters/fs/workspace.ts` → `adapters/fs/editTarget.ts`; `createFileWorkspace` →
  `createFileEditTarget`.
- `app/session.ts`: constructor field `workspace` → `editTarget` (and the `SessionDeps` type).
- `cli/app.ts`: local `workspace` binding → `editTarget`.
- Test mocks/fakes referencing `workspace` in `tests/app/*.test.ts` updated to match.

### Endpoints (`adapters/web/server.ts`)

`ServerOptions` gains a `projectTree: ProjectTree` field, constructed in `cli/app.ts`
alongside `editTarget` and passed into `serveApp` independently of `session` — the server
wiring stays as decoupled from the review session as the feature itself is.

- `GET /files` → `json(await projectTree.list())` — the full flat path list.
- `GET /files/content?path=...` → `text = await projectTree.read(path)`; `text === null` →
  `json({ error: 'not found' }, 404)`, else `json({ text })`. Mirrors the existing `/region`
  endpoint's shape.

### UI

- New `FileTree.tsx`. A left-edge panel, toggled by a button in `App.tsx`'s header, closed by
  default — it does not shrink the conversation column unless opened. Independent of
  `hasBoard` and everything `ChunkList` does; not a third tab bolted onto its existing
  board/activity toggle.
- Fetches `/files` once when the panel opens. Builds a nested tree client-side from the flat
  path list (directories before files, alphabetical within each). Expand/collapse is local
  `useState` per node — no further network calls. Refetches when `diffRevision` changes while
  the panel is open, reusing `useDiff`'s existing "the tree moved" signal (`App.tsx` already
  computes this; it's not board-specific, it genuinely means the working tree changed).
- Clicking a file fetches `/files/content?path=...` and opens a new `FileViewer` component in
  the same scrim/popup overlay pattern `ChunkView`'s detail panel already uses (`App.tsx`'s
  `showDetail`/`.scrim`/`.work`) — reusing the interaction idiom, not the component. Plain
  `<pre>` of the text, a close button, Escape/backdrop-click to dismiss, matching existing
  conventions. Entirely independent state from the board's `selected`/`picked`/`closed`.

## Data flow

```
panel opened
  -> GET /files -> ProjectTree.list() -> globby (gitignore: true)
  -> client builds nested tree from flat path list

click a folder     -> pure client-side expand/collapse, no request

click a file
  -> GET /files/content?path=... -> ProjectTree.read(path)
       -> traversal guard -> Bun.file(...).text()
  -> FileViewer opens in the shared scrim/popup, read-only

diffRevision changes while panel open
  -> refetch GET /files (tree may have gained/lost files)
```

## Error handling

| Situation | Behavior |
|---|---|
| `globby` throws (e.g. unreadable directory) | `/files` responds 500 with `{ error }`; panel shows an inline "couldn't list files" message instead of an empty or broken tree. |
| File deleted between listing and click | `/files/content` responds 404; viewer shows "no longer exists" instead of content. |
| Path traversal attempt (`../..`, absolute path, NUL byte) | Same guard as `EditTarget` — resolves to `null`/404, never reads outside the project root. |
| Binary file clicked | Rendered as whatever `Bun.file().text()` decodes to. Explicitly out of scope to detect or special-case (see Non-goals). |

## Testing

- `tests/adapters/fs/projectTree.test.ts`: a real temp directory with a nested structure and
  a nested `.gitignore`, verifying `list()` excludes ignored files/dirs (including the nested
  ignore) and always excludes `.git`; verifying `read()` returns content for a real file,
  `null` for a missing one, and `null` for traversal attempts.
- `tests/adapters/fs/safePath.test.ts`: the extracted traversal-guard helper, covering the
  cases `EditTarget`'s existing tests already implicitly cover for `resolve()`, now shared.
- Route-level coverage for `/files` and `/files/content` (200/404/500 shapes), following the
  existing pattern for other `server.ts` routes.
- `Workspace` → `EditTarget` rename: existing tests updated in place (mock field renamed),
  no new test needed — pure rename, no behavior change.
- UI (`FileTree`, `FileViewer`): no existing component-test harness in this repo to extend;
  verified by hand in the browser per the project's own convention for UI changes — expand
  nested folders, open a file, confirm content renders, confirm gitignored files (e.g.
  `node_modules`) don't appear.
