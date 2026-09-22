# Git Rail — Design

Imported from a Claude Design canvas project (`Turnstile - Git rail.dc.html`,
`claude.ai/design/p/d446f398-f6ca-44a0-92a5-8f5cc1a728d4`). The mockup composes the whole app
for context; the header/status bar and left "board" sidebar it shows are already implemented
(`TopBar.tsx`, `Sidebar.tsx`). The only new surface is the right-hand collapsible panel it
calls the **git rail**.

## Context

Turnstile's board (`Sidebar.tsx` / `ReviewRail.tsx`) shows the *aggregate* diff between the
branch point and the working tree — one flat list of chunks, with no notion of which commit
introduced which change. There is currently no way to see the branch's own shape: what was
committed, in what order, and — since Turnstile's whole job is gating changes — whether each
commit's content was ever actually reviewed.

This spec adds a read-only right-hand rail listing commits since the branch diverged from
trunk (newest first), each annotated with a review-state badge, plus a "working tree" entry
at the top for whatever is still uncommitted. It reuses the merge-base/ledger machinery that
already powers the board rather than inventing a parallel notion of "reviewed."

## Goals

- List commits between the branch point (`merge-base(trunk, HEAD)`) and `HEAD`, newest first,
  each with subject, file/added/removed counts, and a review-state badge.
- Surface uncommitted work the same way, as one more entry above the commit list.
- Derive the review-state badge from the **existing** `ReviewLedger` — no new bookkeeping, no
  new writes. A commit's state is a pure read-time rollup of what its own chunks' keys already
  say in the ledger.
- Collapsible (44px collapsed / 328px expanded), open by default, matching the mockup.
- Mark where the branch point is ("everything below this is already on trunk").

## Non-goals

- **Editing/reverting from the rail.** Strictly read-only, per the mockup's own framing
  ("Read-only" in the subtitle).
- **The four boolean toggles in the design file's component props**
  (`showWorkingTree`/`showReviewState`/`showBranchPoint`/`gitRailOpen`). Those are the design
  tool's own preview knobs for iterating the mock, not real app configuration — implemented
  as always-on behavior instead (open/closed is the one real piece of interaction state).
- **Merge commits / non-linear history.** `CommitLog` takes each commit's first parent via
  `%P`'s first token. A branch with merge commits in it renders each merge's first-parent diff
  like any other commit; reconstructing per-parent history is out of scope.
- **Cross-branch or historical ledger state ("was this ever approved on some other branch").**
  The rollup reads the *current* branch's ledger bucket only, same scoping every other ledger
  read in the app already uses.
- **Live git-log watching / a dedicated refresh signal.** Refetches on the same `diffRevision`
  trigger `useDiff` already uses — see Data flow.

## Architecture

### `core/ports.ts`: two additions, one extension

```ts
export type CommitEntry = {
  sha: string
  /** First parent only (`%P`'s first token) — see Non-goals re: merge commits. Null for a
   *  root commit. */
  parentSha: string | null
  subject: string
}

/** Git's own commit graph, independent of the ledger or the board. */
export interface CommitLog {
  /** Commits reachable from HEAD but not from `base`, newest first. Empty when `base` is
   *  HEAD itself, or resolves to the same commit. */
  since(base: string): Promise<CommitEntry[]>
}

export type RailState = 'approved' | 'sent-back' | 'quiet'

export type RailEntry = {
  sha: string | null // null for the synthetic "working tree" entry
  subject: string
  filesChanged: number
  added: number
  removed: number
  state: RailState
}

export type GitRailView = {
  branch: string | null
  trunk: string | null
  /** True only when a real merge-base was found — gates the branch-point marker and the
   *  commit list together (see BaselineResolution.mergeBaseCommit below). */
  atBranchPoint: boolean
  commits: RailEntry[]
  /** Null when the working tree matches HEAD exactly. */
  workingTree: RailEntry | null
}

export interface GitRail {
  view(): Promise<GitRailView>
}
```

`BaselineResolution` (existing type) gains one field:

```ts
export type BaselineResolution = {
  tree: SnapshotId
  source: 'merge-base' | 'session-start' | 'head' | 'empty'
  trunk: string | null
  branch: string | null
  /** The merge-base *commit* (not its tree) — set only when `source === 'merge-base'`. A
   *  tree object has no history, so `git log <tree>..HEAD` doesn't work; the rail needs the
   *  actual commit-ish `mergeBase()` already computes internally before `resolve()` discards
   *  it down to a tree. */
  mergeBaseCommit: string | null
}
```

### `adapters/git/baseline.ts`: thread the commit sha through

`resolve()`'s `source === 'merge-base'` branch already has `base` (the commit sha, from
`mergeBase()`) in scope before it resolves `${base}^{tree}`. One extra field on the return:
`mergeBaseCommit: base`. The other three return points (`session-start`, `head`, `empty`) set
it to `null`. No behavior change to anything already reading this type.

### `adapters/git/log.ts` (new)

```ts
export function createGitCommitLog(options: { cwd: string }): CommitLog
```

`git log --format=%H%x1f%P%x1f%s%x1e base..HEAD`, split on `\x1e` (records) then `\x1f`
(fields) — the same delimiter-based parsing style `delta.ts` already uses for
`--name-status -z`. `%P` is space-separated parent shas; take the first token (or `null` for
a root commit).

### `app/gitrail.ts` (new): the orchestrator

```ts
export type GitRailDeps = {
  snapshots: SnapshotStore
  baseline: Baseline
  commitLog: CommitLog
  ledger: ReviewLedger
}

export function createGitRail(deps: GitRailDeps): GitRail
```

`view()`:

1. `resolution = await deps.baseline.resolve(null)` — same call shape `currentBranch()` in
   `app/board.ts` already makes. `null` (no session-start fallback) is deliberate: the rail
   only ever wants the merge-base rung or nothing, never the session-start/head/empty
   fallbacks that exist purely so the *board* always has something to diff against. Those
   fallbacks don't mean anything as a git-log range.
2. `decided = await deps.ledger.all(resolution.branch)`.
3. Build one `RailEntry` per commit — `for (const commit of await deps.commitLog.since(mergeBaseCommit))`.
   Every commit in this range is guaranteed to have a parent: `mergeBaseCommit` is by
   definition an ancestor of everything `since()` returns, so a parentless (root) commit can
   only occur if the repo has no merge-base at all — a case this loop never reaches, since it
   only runs when `mergeBaseCommit !== null`. `commit.parentSha` is used directly, un-guarded
   (skip the commit defensively if it were ever somehow null — see Error handling — rather
   than reach for an empty-tree constant, which lives in the git adapter and isn't something
   `app/` can name):
   - `delta = await deps.snapshots.delta(parent, commit.sha)` (falls straight through to the
     already-generic `computeDelta` — it only ever assumes two tree-ish snapshot ids, and a
     commit sha resolves to one exactly as well as `mergeBase`/`next` already do elsewhere).
   - `chunks = await chunksOf(deps.snapshots, parent, commit.sha, delta)` — **reusing
     `app/board.ts`'s existing exported `chunksOf`** unchanged.
   - `filesChanged/added/removed` from summing `delta[].addedLines.length` /
     `.removedLines.length` / `delta.length` — the same fields `FileDelta` already carries,
     no new stat plumbing.
   - `state = rollUp(chunks, decided)` (see below).
4. Build the `workingTree` entry the same way, diffing `headTree` (from `SnapshotStore.head()`)
   against `next` (from `SnapshotStore.capture()`); its `RailEntry.sha` is `null` (it isn't a
   commit) — the whole entry is `null` instead of a zero-stat `RailEntry` when
   `delta.length === 0`, so a clean working tree shows no card at all rather than an empty one.
5. `atBranchPoint = resolution.mergeBaseCommit !== null`; `commits = []` when false.

**Rollup rule** (`rollUp(chunks, decided)`):

```
sent-back  if any chunk.key is in `decided` with outcome === 'sent-back'
approved   else if chunks.length > 0 and every chunk.key is in `decided`
                with outcome === 'approved' | 'yours'
quiet      otherwise (includes: no chunks, binary-only diff, any chunk with
           outcome 'auto'/'archived', or any chunk simply absent from the ledger —
           never explicitly decided, whether risk-bar-skipped or predating the ledger)
```

This is a straight read over `ChunkReview.outcome`, which already has exactly this
granularity (`core/types.ts`'s `OUTCOMES`) — no new classification logic, no re-running the
risk bar. "Quiet" deliberately collapses several distinct reasons into one badge, matching the
mockup's own three-state design (`approved`/`sentBack`/`quiet` in its demo data).

### `adapters/web/server.ts`

`ServerOptions` gains `gitRail: GitRail`, alongside the existing `projectTree` field — same
independence: this route knows nothing about `session`.

```ts
'/git-rail': async () => json(await gitRail.view()),
```

Pull, not pushed in the broadcast — see Data flow for why.

### `cli/app.ts`

```ts
const commitLog = createGitCommitLog({ cwd })
const gitRail = createGitRail({ snapshots, baseline, commitLog, ledger })
...
const server = serveApp({ session, projectTree, gitRail, cwd })
```

### UI

- `useGitRail(diffRevision)` in `App.tsx`, mirroring `useDiff` exactly: fetch `/git-rail` on
  mount and whenever `diffRevision` changes, nothing pushed over the socket.
- `GitRail.tsx` (new): the panel. Collapsed/expanded is local `useState(true)`, not persisted
  — same footprint as `conversationOpen`. Collapsed renders the 44px vertical-label button;
  expanded renders the header, the "since it left trunk" subtitle, the optional working-tree
  card, the commit list (a vertical rail line + dot per commit, exactly as the mockup), and
  the branch-point divider when `atBranchPoint`. Each commit's badge color/label comes
  straight from `RailEntry.state` (`approved` → green, `sent-back` → orange, `quiet` → gray) —
  the same three badge treatments the board sections already use (`.pill`-style classes in
  `styles.css`), reused rather than re-invented.
- Wired into `App.tsx`'s `.workspace` grid as a third column, after `main-column` — CSS grid
  `minmax(240px,300px) minmax(0,1fr) auto`, matching the mockup's `grid-template-columns`.

## Data flow

```
GET /git-rail
  -> GitRail.view()
     -> Baseline.resolve(null)                     [trunk, branch, mergeBaseCommit]
     -> ReviewLedger.all(branch)                    [decided: Map<key, ChunkReview>]
     -> CommitLog.since(mergeBaseCommit)             [commits, newest first]
     -> per commit: SnapshotStore.delta + chunksOf  [chunks -> rollUp -> RailEntry]
     -> SnapshotStore.capture() + delta(head, next)  [working tree -> RailEntry | null]
  -> GitRailView

diffRevision changes (new edit, decision, turn boundary)
  -> client refetches GET /git-rail
```

No new push channel: git history and ledger state only change alongside the same events that
already bump `diffRevision`, exactly the reasoning `/diff` and `/files` already rely on.

## Error handling

| Situation | Behavior |
|---|---|
| No trunk resolved (unknown remote, fresh repo) | `trunk`/`branch` may be null; `atBranchPoint: false`, `commits: []`. Working tree still computed. |
| On trunk itself (`mergeBase` returns null) | Same as above — `atBranchPoint: false`. This is the same "merge-base is HEAD itself" case `Baseline.resolve` already documents. |
| `git log` fails (corrupt repo, git binary missing) | `/git-rail` responds 500 with `{ error }`; panel shows an inline error instead of an empty list — distinguishing "nothing to show" from "couldn't ask." |
| Commit touches only excluded/binary paths | `chunks.length === 0` → `quiet`, still listed with its file/added/removed stats. |
| Root commit (no parent) reachable from `HEAD` but not `mergeBaseCommit` | Cannot occur: `mergeBaseCommit` is an ancestor of every commit `since()` returns, so every such commit has a parent. If `CommitEntry.parentSha` is ever unexpectedly null (a `CommitLog` bug), that entry is skipped rather than guessed at — `app/` has no portable way to name the empty tree (that's an `adapters/git` concern), and this rail is read-only history, not something worth failing the whole request over one bad entry. |

## Testing

- `tests/adapters/git/log.test.ts`: real temp repo (same harness as
  `tests/adapters/git/baseline.test.ts`) — linear history, verify ordering (newest first),
  parent shas, subjects; verify `since(HEAD)` returns `[]`.
- `tests/app/gitrail.test.ts`: fake `CommitLog`/`SnapshotStore`/`Baseline`/`ReviewLedger`,
  covering the rollup rule directly — all-approved, any-sent-back-wins, mixed/never-decided
  falls to quiet, empty-chunks commit, working-tree-null-when-clean, `atBranchPoint: false`
  when `mergeBaseCommit` is null.
- `tests/adapters/web/server.test.ts`: extend for `/git-rail`, following the existing
  `/files`-style route test.
- `BaselineResolution.mergeBaseCommit`: extend `tests/adapters/git/baseline.test.ts`'s
  existing merge-base assertions to also check the new field; update the two fake `Baseline`
  literals in `tests/app/session.test.ts` / `tests/app/streaming.test.ts` to include it.
- UI (`GitRail.tsx`): no component-test harness in this repo to extend; verified by hand in
  the browser per project convention — collapse/expand, commit badges match ledger decisions
  made during a real review, branch-point marker appears/disappears correctly on trunk vs. a
  feature branch.
