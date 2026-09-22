# Nocturne Review Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Executed inline in the planning session.** The planner held full context of both the
> target design and the current codebase and executed this plan directly rather than
> dispatching fresh subagents, since re-deriving that context would have cost more than it
> saved. A future resumer with no prior context should still use subagent-driven-development
> or executing-plans per task.

**Goal:** Replace ISR's current "board above conversation, file tree drawer, modal review
popup" web UI with the three-tab (Review / Session / Files) design from Claude Design's
"ISR Redesign.dc.html", restyled in the Nocturne design system, without changing any
server-side review semantics beyond two small, port-first additions (current branch name,
diff totals).

**Architecture:** Pure `adapters/web/ui` restructuring (React, no new dependencies) plus two
narrow `core`/`app` additions that follow the existing port pattern exactly: `Baseline`
gains the current branch name, `DiffView` gains `branch`/`trunk` so the client can render
"feature → main" without a new endpoint (added-line/removed-line totals are summed
client-side from the diff already fetched — no new data needed). `core/livechunks.ts`'s
`groupBoard` is reshaped from a 2-bucket (attention/archive) split into the 4-bucket split
the new rail shows (waiting on you / back with the agent / you approved / passed without
review) — same function, same test file, new shape.

**Tech Stack:** React 19, Bun's bundler (no Vite/CSS pipeline — `bun build` embeds
`ui/*.tsx` + `styles.css` directly), `bun:test`.

**Spec:** `~/Downloads/agent-harness-ui-redesign/project/ISR Redesign.dc.html`
(the target — read in full), plus its imports: `_ds/nocturne-.../styles.css` (design tokens
+ component classes) and `_ds/nocturne-.../readme.md` (usage rules). `support.js` is the
Claude Design canvas runtime, not part of the design — ignore it.

## Global Constraints

- Nocturne tokens (from the spec's `styles.css`): `--color-bg #161826`, `--color-surface
  #232532`, `--color-text #e9e9ed`, `--color-accent #9184d9` (mono accent scheme — no second
  hue), neutral/accent 100–900 ramps, `--font-heading`/`--font-body` = Inter (headings,
  buttons, labels, prose), monospace reserved for code/paths/diffs/kbd — this is a base
  typography flip from ISR's current all-monospace body font.
- Spacing scale `--space-1..8` (2.8/5.6/8.4/11.2/16.8/22.4px), radius `--radius-sm/md/lg`
  (4/8/14px), shadows `--shadow-sm/md/lg` — use the variables, never raw px for these.
- `adapters/web/ui/*` may import only `core` or itself (architecture test enforced) — no new
  adapter dependency for the UI layer.
- No new npm dependencies; no CSS build step. Google Fonts `@import` for Inter, same as the
  spec's stylesheet already does.
- **Cut, by explicit user decision:** no "agent's claim" card. The mockup's two-card
  claim/challenge layout is not implemented — only the real `riskReason` (the challenge) is
  shown, single-card, because the pipeline deliberately has no per-chunk claim step
  (`synthesizer.ts`'s own comment explains why it was removed). Do not add a model call to
  manufacture one.
- **Cut, by planner judgment (state these to the user when the branch is done):**
  - No `⌘K` fuzzy command palette — the Files tab's "Jump to a file ⌘K" input does live
    substring filtering of the tree instead, and `⌘K` focuses it (switching to the Files tab
    first if needed).
  - No `N` "note on this line" keyboard shortcut — the existing hover-triggered `+` button on
    each diff line (`Diff.tsx`) is the only way to add a line note. There is no keyboard-
    addressable "current line" cursor in the diff view to hang this on, and building one is
    out of proportion to the rest of this task.
  - Screen 4 ("Idle") in the spec shows the `Review` tab underlined, but its content (a plain
    "nothing waiting on you" summary plus a chat-style send box) and the section heading
    grouping it with Screen 3 under "Session — the agent working, and idle" both say this is
    the **Session tab's idle state**, not the Review tab's. Treated as a copy-paste artifact
    in the static mockup; implemented as the Session tab's empty state.
  - The Review tab's own empty state (nothing on the board at all) has no dedicated mockup
    screen — kept minimal, consistent with the existing placeholder copy ("Nothing has
    changed on this branch yet").
  - The existing "Activity" log view (every past decision, browsable) has no home in the new
    rail's mockup. It is not dropped — it moves to a small unobtrusive control in the rail
    (see Task 7) rather than being deleted.

---

## File Structure

- Modify `src/core/ports.ts` — `BaselineResolution` gains `branch: string | null`.
- Modify `src/adapters/git/baseline.ts` — resolves current branch name (`git rev-parse
  --abbrev-ref HEAD`), threads it through both `resolve()` return paths.
- Modify `tests/adapters/git/baseline.test.ts` — coverage for the new field.
- Modify `src/core/types.ts` — `DiffView` gains `branch: string | null` and `trunk: string |
  null`.
- Modify `src/app/session.ts` — `diffBetween`/`failedDiff` populate the new `DiffView`
  fields from the `BaselineResolution` already in scope in `diff()`.
- Modify `tests/app/session.test.ts` — the shared `fakeBaseline` fixture gains `branch`;
  one assertion on `session.diff()` covers the new fields passing through.
- Modify `src/core/livechunks.ts` — `groupBoard`/`BoardSections` reshaped to 4 buckets.
- Modify `tests/core/livechunks.test.ts` — updated for the new shape.
- Rewrite `src/adapters/web/ui/styles.css` — Nocturne tokens and typography; new component
  classes for the tab bar, rail rows, session banner, files pane; existing diff/note/editor
  rules re-skinned to the new palette.
- New `src/adapters/web/ui/TopBar.tsx` — the traffic-light bar, Review/Session/Files tabs
  with badges, branch/diffstat readout.
- Rewrite `src/adapters/web/ui/App.tsx` — becomes the shell: `mode` state
  (`'review' | 'session' | 'files'`), global keyboard shortcuts (`⌘1/2/3`), renders
  `TopBar` + the active pane. Owns `useSession`/`useDiff` (unchanged) and passes them down.
- Rename+rewrite `src/adapters/web/ui/ChunkList.tsx` → `src/adapters/web/ui/ReviewRail.tsx`
  — 4-bucket grouped file rows; `Activity` reachable via a small link, unchanged internally.
- New `src/adapters/web/ui/ReviewPane.tsx` — composes `ReviewRail` (left) + review detail
  (right) as a real two-column layout (no scrim/overlay); J/K file navigation, empty states.
- Rewrite `src/adapters/web/ui/ChunkView.tsx` (stays this name — it is still "the detail view
  for a file's chunks", just no longer an overlay) — drops the overlay close button; adds
  region-N-of-M header, single-card risk display, "Read it" collapse-when-`none`-risk gate,
  "opened every region" state gating Approve, Whole-file/Edit-lines/Next-file header
  controls, `A`/`R` keyboard shortcuts.
- New `src/adapters/web/ui/SessionPane.tsx` — the conversation, lifted out of `App.tsx`
  nearly verbatim, plus the "N changes are waiting on you" banner and the idle empty state.
- New `src/adapters/web/ui/FilesPane.tsx` — file tree + filter input + inline content
  preview + "Review this change" button, replacing `FileTree.tsx`'s drawer-and-popup.
- Delete `src/adapters/web/ui/FileTree.tsx` (superseded by `FilesPane.tsx`).

## Interfaces (carried across tasks)

```ts
// core/ports.ts
export type BaselineResolution = {
  tree: SnapshotId
  source: 'merge-base' | 'session-start' | 'head' | 'empty'
  trunk: string | null
  branch: string | null   // NEW — current branch name (`git rev-parse --abbrev-ref HEAD`),
                           // null on detached HEAD or when it cannot be resolved.
}

// core/types.ts
export type DiffView = {
  base: string
  files: DiffFile[]
  error: string | null
  branch: string | null   // NEW — current branch name, from BaselineResolution.
  trunk: string | null    // NEW — trunk name, from BaselineResolution.
}

// core/livechunks.ts
export interface ReviewSections {
  waitingOnYou: LiveChunk[]        // isOutstanding(chunk, verdicts, reviewKeys)
  backWithAgent: LiveChunk[]       // !outstanding && board === 'sent-back'
  approved: LiveChunk[]            // !outstanding && (board === 'approved' || board === 'yours')
  passedWithoutReview: LiveChunk[] // !outstanding && board === 'auto'
}
export function groupBoard(
  chunks: LiveChunk[],
  verdicts: Record<string, ChangeVerdict>,
  reviewKeys: readonly string[] | null,
): ReviewSections
// `prior` chunks are dropped, same as today. waitingOnYou sorted by path/startLine
// (unchanged); the other three sorted by decidedAt desc (unchanged sort, new partition).
```

```tsx
// adapters/web/ui/App.tsx — top-level mode
type Mode = 'review' | 'session' | 'files'
```

---

### Task 1: Current branch name on `BaselineResolution`

**Files:**
- Modify: `src/core/ports.ts:128-133` (`BaselineResolution`)
- Modify: `src/adapters/git/baseline.ts` (`createGitBaseline`)
- Test: `tests/adapters/git/baseline.test.ts`

**Interfaces:**
- Produces: `BaselineResolution.branch: string | null`, used by Task 2.

- [x] **Step 1: Write the failing test**

Add to `tests/adapters/git/baseline.test.ts`, inside a `describe('createGitBaseline')` block
(create one if none exists — check the file first; there is already a `baselineFor` helper
at the top of the file):

```ts
test('resolve() reports the current branch name', async () => {
  await git(repo, ['checkout', '-q', '-b', 'feature/x'])
  const result = await baselineFor().resolve(null)
  expect(result.branch).toBe('feature/x')
})

test('resolve() reports null branch on detached HEAD', async () => {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(repo, ['checkout', '-q', head])
  const result = await baselineFor().resolve(null)
  expect(result.branch).toBeNull()
})
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/adapters/git/baseline.test.ts -t "current branch"`
Expected: FAIL — `result.branch` is `undefined`, not typed on `BaselineResolution` yet
(TypeScript error until Step 3, or a runtime `undefined !== 'feature/x'` failure).

- [x] **Step 3: Add the field and resolve it**

In `src/core/ports.ts`, add to `BaselineResolution`:

```ts
export type BaselineResolution = {
  tree: SnapshotId
  source: 'merge-base' | 'session-start' | 'head' | 'empty'
  trunk: string | null
  /** The current branch name (`git rev-parse --abbrev-ref HEAD`), or null on detached HEAD
   *  or when it cannot be resolved. */
  branch: string | null
}
```

In `src/adapters/git/baseline.ts`, add a helper and call it once per `resolve()`, threading
the result into every return:

```ts
async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (result.exitCode !== 0) return null
  const name = result.stdout.trim()
  return name === '' || name === 'HEAD' ? null : name
}
```

Then in `resolve()`, compute `const branch = await currentBranch(cwd)` once at the top and
add `branch` to all three `return` statements (merge-base, session-start, head/empty).

- [x] **Step 4: Run to verify it passes**

Run: `bun test tests/adapters/git/baseline.test.ts`
Expected: PASS, all tests including the two new ones.

- [x] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no new errors (the `Baseline` fake in `tests/app/session.test.ts` will now be
missing `branch` — fix it in Task 2, which touches that file next; typecheck may show that
one error until then, which is expected and resolved by Task 2).

- [x] **Step 6: Commit**

```bash
git add src/core/ports.ts src/adapters/git/baseline.ts tests/adapters/git/baseline.test.ts
git commit -m "Resolve the current branch name alongside the baseline"
```

---

### Task 2: Branch/trunk on `DiffView`

**Files:**
- Modify: `src/core/types.ts` (`DiffView`)
- Modify: `src/app/session.ts:1015-1047` (`diffBetween`, `failedDiff`)
- Modify: `tests/app/session.test.ts` (`fakeBaseline`, one `diff()` assertion)

**Interfaces:**
- Consumes: `BaselineResolution.branch`/`.trunk` from Task 1.
- Produces: `DiffView.branch`/`DiffView.trunk`, used by `TopBar.tsx` in Task 5.

- [x] **Step 1: Update the fake and write the failing assertion**

In `tests/app/session.test.ts`, find `fakeBaseline` (around line 74: `resolve: async () =>
({ tree: 'tree-base', source: 'merge-base', trunk: 'main' })`) and add `branch:
'feature-branch'` to its return value. Then extend one existing `session.diff()` assertion
(around line 878 or 1287 — pick the simplest passing case already in the file) to also
check:

```ts
expect(view.branch).toBe('feature-branch')
expect(view.trunk).toBe('main')
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/app/session.test.ts -t "diff"`
Expected: FAIL — `view.branch`/`view.trunk` are `undefined`.

- [x] **Step 3: Add the fields**

In `src/core/types.ts`, add to `DiffView`:

```ts
export type DiffView = {
  base: string
  files: DiffFile[]
  error: string | null
  /** Current branch name, from the baseline resolution. Null on detached HEAD. */
  branch: string | null
  /** The trunk branch this work is measured against, when one was found. */
  trunk: string | null
}
```

In `src/app/session.ts`, `diff()` already destructures `{ base, next }` from `captureBoard`
— change it to also keep `resolution`:

```ts
async diff(): Promise<DiffView> {
  try {
    const { base, next, resolution } = await captureBoard(deps)
    return await diffBetween(base, next, resolution.branch, resolution.trunk)
  } catch (error) {
    return failedDiff(error)
  }
},
```

Update `diffBetween` and `failedDiff` signatures/returns:

```ts
async function diffBetween(
  base: SnapshotId,
  next: SnapshotId,
  branch: string | null,
  trunk: string | null,
): Promise<DiffView> {
  // ...unchanged body...
  return { base, files, error: null, branch, trunk }
}

function failedDiff(error: unknown): DiffView {
  return {
    base: '',
    files: [],
    error: error instanceof Error ? error.message : String(error),
    branch: null,
    trunk: null,
  }
}
```

Check the two other call sites of `diffBetween` in `session.ts` (there is at least one more
— search `diffBetween(` in the file) and pass `resolution.branch`/`resolution.trunk` from
whatever `BoardDeps`/`captureBoard` result is in scope at each; if a call site has no
resolution in scope, pass `null, null` rather than threading new plumbing — the header
degrades gracefully to just the diff stat with no branch label when that happens.

- [x] **Step 4: Run to verify it passes**

Run: `bun test tests/app/session.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: no errors, full suite green (this also confirms Task 1's fake fix above resolved
the earlier typecheck gap).

- [x] **Step 6: Commit**

```bash
git add src/core/types.ts src/app/session.ts tests/app/session.test.ts
git commit -m "Carry branch and trunk name through to the diff view"
```

---

### Task 3: Reshape `groupBoard` into the 4-bucket review rail split

**Files:**
- Modify: `src/core/livechunks.ts:245-282` (`BoardSections`, `groupBoard`)
- Modify: `tests/core/livechunks.test.ts:400-449` (`describe('groupBoard', ...)`)

**Interfaces:**
- Produces: `ReviewSections` (see the Interfaces section above), consumed by
  `ReviewRail.tsx` in Task 7.

- [x] **Step 1: Write the failing tests**

Replace the existing `describe('groupBoard', ...)` block in
`tests/core/livechunks.test.ts` with:

```ts
describe('groupBoard', () => {
  function live(overrides: Partial<LiveChunk> = {}): LiveChunk {
    return { ...(reconcile([chunk('a')], none, idle, [])[0] as LiveChunk), ...overrides }
  }

  test('a prior chunk is dropped from every section', () => {
    const sections = groupBoard([live({ board: 'prior' })], {}, null)
    expect(sections.waitingOnYou).toEqual([])
    expect(sections.backWithAgent).toEqual([])
    expect(sections.approved).toEqual([])
    expect(sections.passedWithoutReview).toEqual([])
  })

  test('an awaiting chunk is waiting on you', () => {
    const sections = groupBoard([live({ board: 'awaiting' })], {}, null)
    expect(sections.waitingOnYou.map((c) => c.key)).toEqual(['a'])
  })

  test("sent-back is waiting on you only while it's one of the current round's own keys, otherwise back with the agent", () => {
    const sentBack = live({ board: 'sent-back' })
    expect(groupBoard([sentBack], {}, null).waitingOnYou).toEqual([])
    expect(groupBoard([sentBack], {}, ['a']).waitingOnYou.map((c) => c.key)).toEqual(['a'])
    expect(groupBoard([sentBack], {}, null).backWithAgent.map((c) => c.key)).toEqual(['a'])
  })

  test('approved and yours land in approved', () => {
    for (const board of ['approved', 'yours'] as const) {
      const sections = groupBoard([live({ board })], {}, null)
      expect(sections.approved.map((c) => c.key)).toEqual(['a'])
      expect(sections.waitingOnYou).toEqual([])
      expect(sections.backWithAgent).toEqual([])
      expect(sections.passedWithoutReview).toEqual([])
    }
  })

  test('auto lands in passed without review', () => {
    const sections = groupBoard([live({ board: 'auto' })], {}, null)
    expect(sections.passedWithoutReview.map((c) => c.key)).toEqual(['a'])
  })

  test('waitingOnYou is ordered by path, then start line', () => {
    const chunks = [
      live({ key: 'b', path: 'src/b.ts', startLine: 1, board: 'awaiting' }),
      live({ key: 'a2', path: 'src/a.ts', startLine: 20, board: 'awaiting' }),
      live({ key: 'a1', path: 'src/a.ts', startLine: 5, board: 'awaiting' }),
    ]
    expect(groupBoard(chunks, {}, null).waitingOnYou.map((c) => c.key)).toEqual([
      'a1',
      'a2',
      'b',
    ])
  })

  test('approved is ordered most recently decided first', () => {
    const chunks = [
      live({ key: 'old', board: 'approved', decidedAt: '2026-09-01T10:00:00.000Z' }),
      live({ key: 'new', board: 'approved', decidedAt: '2026-09-02T10:00:00.000Z' }),
    ]
    expect(groupBoard(chunks, {}, null).approved.map((c) => c.key)).toEqual(['new', 'old'])
  })
})
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/core/livechunks.test.ts -t "groupBoard"`
Expected: FAIL — `sections.waitingOnYou` etc. are `undefined` against the current
`{ attention, archive }` shape.

- [x] **Step 3: Reshape the implementation**

In `src/core/livechunks.ts`, replace `BoardSections` and `groupBoard`:

```ts
/** The review rail's four sections: what needs a decision, what's back with the agent
 *  after a rejection, and the two ways something can already be settled. */
export interface ReviewSections {
  waitingOnYou: LiveChunk[]
  backWithAgent: LiveChunk[]
  approved: LiveChunk[]
  passedWithoutReview: LiveChunk[]
}

export function groupBoard(
  chunks: LiveChunk[],
  verdicts: Record<string, ChangeVerdict>,
  reviewKeys: readonly string[] | null,
): ReviewSections {
  const waitingOnYou: LiveChunk[] = []
  const backWithAgent: LiveChunk[] = []
  const approved: LiveChunk[] = []
  const passedWithoutReview: LiveChunk[] = []

  for (const chunk of chunks) {
    if (chunk.board === 'prior') continue
    if (isOutstanding(chunk, verdicts, reviewKeys)) {
      waitingOnYou.push(chunk)
    } else if (chunk.board === 'sent-back') {
      backWithAgent.push(chunk)
    } else if (chunk.board === 'auto') {
      passedWithoutReview.push(chunk)
    } else {
      approved.push(chunk)
    }
  }

  waitingOnYou.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
  const byRecency = (a: LiveChunk, b: LiveChunk) =>
    (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')
  backWithAgent.sort(byRecency)
  approved.sort(byRecency)
  passedWithoutReview.sort(byRecency)

  return { waitingOnYou, backWithAgent, approved, passedWithoutReview }
}
```

Keep everything else in the file (`ATTENTION`, `isOutstanding`, `resolveActive`, etc.)
unchanged — only `BoardSections`/`groupBoard` move.

- [x] **Step 4: Run to verify it passes**

Run: `bun test tests/core/livechunks.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: fails at `src/adapters/web/ui/App.tsx` and `ChunkList.tsx` (both still reference
`.attention`/`.archive`) — expected until Task 6/7 land; do not fix those files here, this
task's scope is the `core` function only. Confirm the *only* new errors are in those two UI
files, nothing else.

- [x] **Step 6: Commit**

```bash
git add src/core/livechunks.ts tests/core/livechunks.test.ts
git commit -m "Reshape the board grouping into the review rail's four sections"
```

---

### Task 4: Nocturne tokens and base typography

**Files:**
- Modify: `src/adapters/web/ui/styles.css` (root tokens, `body`, headings)
- Modify: `src/adapters/web/ui/index.html` (add the Inter `@import` / Google Fonts link if
  `index.html` currently declares fonts there rather than in the CSS — check first; the spec
  loads Inter via `@import url(...)` at the top of its stylesheet, which is simplest and
  keeps everything in one file)

**Interfaces:**
- Produces: the `--color-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--font-heading`,
  `--font-body` custom properties every later task's CSS is written against.

- [x] **Step 1: Replace the `:root` token block**

Read the current `:root` block (`src/adapters/web/ui/styles.css:8-30`, the `--bg`/`--panel`/
`--line`/`--text`/`--muted`/`--accent`/`--agent`/`--add`/`--remove`/`--mono` set). Replace it
with the Nocturne set, transcribed from
`_ds/nocturne-46796f09-2e94-4f40-820d-bc01cd78bc6b/styles.css` lines 1–81 (the `@import`,
every `--color-*`, `--font-*`, `--space-*`, `--radius-*`, `--shadow-*`). Then add ISR's own
semantic aliases on top, so the ~150 existing rules using the old names keep working without
a full rewrite, remapped to the closest Nocturne token:

```css
:root {
  /* ...full Nocturne token block goes here, verbatim from the spec's styles.css... */

  /* ISR's existing semantic names, remapped onto Nocturne tokens. New code should prefer
     the --color-*/--space-* tokens directly; these exist so untouched rules re-skin for
     free. */
  --bg: var(--color-bg);
  --panel: var(--color-surface);
  --line: var(--color-divider);
  --text: var(--color-text);
  --muted: var(--color-neutral-500);
  --accent: #9184d9; /* --color-accent, kept as its own hex here since --color-accent-300
     (the ramp step the design system recommends for paragraph-sized accent text) is too
     light for --accent's other job as a border/icon color throughout the existing CSS */
  --agent: var(--color-neutral-400); /* Nocturne is a mono-accent scheme — the agent no
     longer gets its own hue; "you" is accent, "agent" is neutral, matching the mockup's
     transcript entry colors */
  --agent-rail: var(--color-neutral-800);
  --add: #7fbfa0;
  --add-wash: rgb(79 157 118 / 14%);
  --add-text: #b3ddc6;
  --remove: #d9948a;
  --del: rgb(207 122 110 / 14%);
  --del-text: #e8b8b0;
  --border: var(--color-divider);
  --accept: var(--add);
  --reject: var(--remove);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
```

- [x] **Step 2: Flip the base typography**

Replace:

```css
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px / 1.55 var(--mono);
}
```

with:

```css
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font: 15px / 1.55 var(--font-body);
}
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 500;
}
```

- [x] **Step 3: Re-apply monospace where the app actually needs it**

Base font is now Inter, so every element that used to inherit monospace from `body` and
still needs it (diff code/gutters, file paths, chunk headings, `<kbd>`, the editor textarea)
needs an explicit `font-family: var(--mono)`. Grep for the elements that render code or
paths and add it — do this by searching the stylesheet for the classes `Diff.tsx`,
`ChunkView.tsx`, `ChunkList.tsx`/`ReviewRail.tsx`, `FileTree.tsx`/`FilesPane.tsx` render text
into (`.line .code`, `.gutter`, `.chunk-file`, `.chunk-head h2`, `.activity-path`,
`.tree-row`, `.file-head`, `kbd`, `.editor textarea`, `.lines`) and add
`font-family: var(--mono);` to each rule (or introduce one shared `.mono` class and apply it
in the relevant JSX — either is fine; prefer whichever touches fewer lines given what Tasks
6–11 are about to rewrite anyway).

- [x] **Step 4: Visual check**

Run the app (`bun src/cli/main.ts` in a scratch repo with a small diff pending, or the `run`
skill) and confirm: the page background is now `#161826`, body text is Inter, and diff
lines/file paths/kbd hints are still monospace, not sans. This step has no automated test —
it is a visual sanity check before the rest of the redesign is built on top of these tokens.

- [x] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: unaffected by a CSS-only change; both should already pass (fix anything that
doesn't — it was broken before this task if so).

- [x] **Step 6: Commit**

```bash
git add src/adapters/web/ui/styles.css
git commit -m "Retheme the web UI to the Nocturne design tokens"
```

---

### Task 5: `TopBar.tsx` — tabs, badges, branch/diffstat

**Files:**
- New: `src/adapters/web/ui/TopBar.tsx`
- Modify: `src/adapters/web/ui/styles.css` (new `.top-bar` rules)

**Interfaces:**
- Consumes: `SessionState` (`status`, `chunks`, `review`), `DiffView | null` (for
  `branch`/`trunk`/added-removed totals), `mode: Mode`, `onModeChange: (mode: Mode) => void`.
- Produces: the `TopBar` component, mounted by `App.tsx` in Task 6.

- [x] **Step 1: Write the component**

```tsx
import type { DiffView, SessionState } from '../../../core/types.ts'
import type { Waiting } from '../../../core/waiting.ts'

export type Mode = 'review' | 'session' | 'files'

export function TopBar({
  mode,
  onModeChange,
  reviewCount,
  waiting,
  diff,
}: {
  mode: Mode
  onModeChange: (mode: Mode) => void
  /** How many changes are waiting on you right now — the Review tab's badge. */
  reviewCount: number
  waiting: Waiting
  diff: DiffView | null
}) {
  const added = diff?.files.reduce((sum, file) => sum + file.patch.addedCount, 0) ?? 0
  const removed = diff?.files.reduce((sum, file) => sum + file.patch.removedCount, 0) ?? 0

  return (
    <header className="top-bar">
      <div className="traffic-lights">
        <span className="dot dot-red" />
        <span className="dot dot-yellow" />
        <span className="dot dot-green" />
      </div>
      <nav className="tabs">
        <button
          type="button"
          className={mode === 'review' ? 'tab active' : 'tab'}
          onClick={() => onModeChange('review')}
        >
          Review
          {reviewCount > 0 && <span className="badge">{reviewCount}</span>}
        </button>
        <button
          type="button"
          className={mode === 'session' ? 'tab active' : 'tab'}
          onClick={() => onModeChange('session')}
        >
          Session
          {waiting.busy && <span className="spinner spinner-inline" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={mode === 'files' ? 'tab active' : 'tab'}
          onClick={() => onModeChange('files')}
        >
          Files
        </button>
      </nav>
      {diff !== null && diff.branch !== null && (
        <div className="branch-stat">
          <span>
            {diff.branch}
            {diff.trunk !== null && ` → ${diff.trunk}`}
          </span>
          {(added > 0 || removed > 0) && (
            <span>
              <span className="added">+{added}</span> <span className="removed">−{removed}</span>
            </span>
          )}
        </div>
      )}
    </header>
  )
}
```

- [x] **Step 2: Style it**

In `styles.css`, add `.top-bar` (flex row, `height: 52px`, `background: #1b1d2c`, `padding: 0
var(--space-6)`, `gap: var(--space-6)`), `.traffic-lights .dot` (12px circles, the three
mockup colors `#ff5f57`/`#febc2e`/`#28c840`), `.tabs .tab` (transparent button,
`border-bottom: 2px solid transparent`, `color: var(--color-neutral-400)`, hover →
`var(--color-text)`, `.active` → `border-bottom-color: var(--color-accent); color:
var(--color-text)`), `.badge` (pill, `background: var(--color-accent); color: #171528;
border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600`), `.branch-stat`
(`margin-left: auto`, monospace, `color: var(--color-neutral-500)`, `.added`/`.removed`
colored `var(--add)`/`var(--remove)`). Match the mockup's literal px/font-size values from
Screen 1's header block (lines 32–53 of the spec).

- [x] **Step 3: Visual check (deferred to Task 6)**

`TopBar` has no standalone render target yet — verified once mounted in `App.tsx`.

- [x] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: `TopBar.tsx` itself typechecks; it is not imported anywhere yet so no new errors
from this file (existing `App.tsx`/`ChunkList.tsx` errors from Task 3 persist, expected).

- [x] **Step 5: Commit**

```bash
git add src/adapters/web/ui/TopBar.tsx src/adapters/web/ui/styles.css
git commit -m "Add the tab bar: Review/Session/Files with badges and branch info"
```

---

### Task 6: `App.tsx` shell rework

**Files:**
- Rewrite: `src/adapters/web/ui/App.tsx`

**Interfaces:**
- Consumes: `TopBar` (Task 5), `ReviewPane` (Task 9), `SessionPane` (Task 10), `FilesPane`
  (Task 11) — the latter three do not exist yet at this point in the plan; **do this task
  last among Tasks 5–11**, once all four panes exist, even though it is numbered 6. The
  numbering follows the spec's screen order for readability; the actual build order is
  5, 7, 8, 9, 10, 11, then 6, then 12.
- Produces: `mode` state and the `⌘1`/`⌘2`/`⌘3` shortcuts every pane's own shortcuts (J/K/A/R
  in `ReviewPane`, `⌘K` in `FilesPane`) coexist with.

- [x] **Step 1: Keep, from the current `App.tsx`**

`EMPTY` state, `useSession`, `useDiff`, `post`, file-tree-width localStorage helpers move to
`FilesPane.tsx` (Task 11) since only that pane uses them now — everything else in `App.tsx`
regarding width is dead once `FileTree.tsx`'s drawer is gone. Keep `useSession`/`useDiff`/
`post` in `App.tsx` since `ReviewPane` and `SessionPane` both need `post` and the live
`SessionState`/`DiffView`.

- [x] **Step 2: New shell**

```tsx
export function App() {
  const state = useSession()
  const diff = useDiff(state.diffRevision)
  const [mode, setMode] = useState<Mode>('review')

  const board = useMemo(
    () => groupBoard(state.chunks, state.review?.verdicts ?? {}, state.review?.keys ?? null),
    [state.chunks, state.review],
  )
  const reviewCount = board.waitingOnYou.length
  const reviewing = state.review !== null
  const waiting = waitingOn(state.status, reviewing)

  // Global tab shortcuts. Not while typing — the same guard every per-pane shortcut in
  // ReviewPane/FilesPane uses, so ⌘1 while composing a rejection note doesn't jump tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === '1') { event.preventDefault(); setMode('review') }
      else if (event.key === '2') { event.preventDefault(); setMode('session') }
      else if (event.key === '3') { event.preventDefault(); setMode('files') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <TopBar mode={mode} onModeChange={setMode} reviewCount={reviewCount} waiting={waiting} diff={diff} />
      {mode === 'review' && (
        <ReviewPane state={state} diff={diff} board={board} waiting={waiting} reviewing={reviewing} />
      )}
      {mode === 'session' && (
        <SessionPane state={state} waiting={waiting} reviewing={reviewing} reviewCount={reviewCount} onReview={() => setMode('review')} />
      )}
      {mode === 'files' && (
        <FilesPane state={state} diff={diff} board={board} onReviewChunk={() => setMode('review')} />
      )}
    </div>
  )
}
```

Exact prop shapes are for this task's implementer to finalize against what `ReviewPane`/
`SessionPane`/`FilesPane` actually ended up needing (they are built in Tasks 7–11, before
this task per Step 1's note) — the sketch above is the contract to build them against, not a
literal final signature.

- [x] **Step 3: Style `.app`**

Replace the old `.app { display: grid; grid-template-columns: 1fr; height: 100vh }` /
`.app.files-open` rules with:

```css
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
```

(Each pane now owns its own internal layout — no more shared grid columns between a drawer
and a main column.) Remove `.app.files-open` and its `--file-tree-width`-driven
`grid-template-columns` rule entirely — the file tree is no longer a drawer.

- [x] **Step 4: Typecheck + lint + full test suite**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS. This is the first point where every UI file compiles together again — fix
whatever call-site mismatches show up between this task's sketch and what Tasks 7–11 built.

- [x] **Step 5: Commit**

```bash
git add src/adapters/web/ui/App.tsx src/adapters/web/ui/styles.css
git commit -m "Rebuild the app shell around Review/Session/Files tabs"
```

---

### Task 7: `ReviewRail.tsx` (renamed from `ChunkList.tsx`)

**Files:**
- Rename+rewrite: `src/adapters/web/ui/ChunkList.tsx` → `src/adapters/web/ui/ReviewRail.tsx`
- Modify: `src/adapters/web/ui/styles.css` (rail row styles, replacing `.chunk-list`'s old
  board-panel styling)

**Interfaces:**
- Consumes: `ReviewSections` from Task 3 (`groupBoard`'s new return shape).
- Produces: `ReviewRail`, mounted by `ReviewPane` in Task 9. Same `onSelect`/`selected`/
  `verdicts`/`reviewKeys`/`waiting` props as the old `ChunkList`, minus `attention`/`archive`
  (replaced by the four `ReviewSections` fields) and minus the `reviewing`/`outstanding`
  header-count props (that header text moves into `ReviewPane`'s own top-of-rail summary,
  matching the mockup's "6 files changed / Everything this branch has done to main" block —
  see Task 9).

- [x] **Step 1: Move the file, keep `FileItem` almost as-is**

`git mv src/adapters/web/ui/ChunkList.tsx src/adapters/web/ui/ReviewRail.tsx`. Keep
`FileItem` (the one-row-per-file component) largely unchanged — it already computes
`worstRisk`, `analyzing`/`pending`/`allSkipped`, and the "same verdict this cycle" display
logic correctly; only its section-membership context changes.

- [x] **Step 2: Replace `Section`'s attention/archive framing with the four named groups**

Replace the single `<Section kind="attention"/archive">` pair with four groups matching the
mockup's rail headers exactly (spec lines 65–120): `"Waiting on you"` (badge count, not
collapsible, `border-left: 3px solid var(--color-accent)` accent bar on its rows — see
`background:var(--color-accent-900)` header wash in the spec), `"Back with the agent"`
(not collapsible when non-empty — a file "being revised right now" belongs in view, not
folded away), `"You approved"` (collapsible, closed by default unless it holds the
selection — same `startOpen`/`holdsSelection` pattern the old `archive` section already
has), `"Passed without review"` (same). Reuse the existing `Section` component's collapse
mechanics; just parameterize its title/chunks/`collapsible` per group instead of the old
two-way split.

- [x] **Step 3: Give the Activity log a home**

The old header had a `"Activity"` view-toggle button. Keep the `view: 'board' | 'activity'`
state and the `Activity`/`ActivityEntry` components verbatim (they need no changes — they
don't reference `attention`/`archive`), but move the toggle button into the rail's footer as
a small ghost-styled link (`<button type="button" className="rail-activity-link">Activity
log</button>`) rather than the header bar, since the new header has no room for it (it's now
occupied by the "N files changed" summary — see Task 9).

- [x] **Step 4: Style the rows**

Replace the old `.chunk-item`/`.group`/`.file` rules with ones matching the mockup's literal
values (spec lines 65–120): row padding `var(--space-3) var(--space-6)`, group header
`font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase`, selected row
`background: var(--color-surface); border-left: 3px solid var(--color-accent)`, unselected
hover `background: color-mix(in srgb, var(--color-text) 5%, transparent)`, path shown once
per file group in monospace 13px, file-level risk/status tags reusing the existing `doubt-*`
classes recolored onto the Nocturne ramps (`doubt-high`/`medium`/`low` → shades of
`--remove`/an amber/`--color-neutral-500`; keep the class names, just replace their color
values in this pass).

- [x] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: `ReviewRail.tsx` typechecks standalone against the `ReviewSections` shape from
Task 3. It is not imported anywhere yet (that's Task 9) so no cross-file errors from this
task specifically.

- [x] **Step 6: Commit**

```bash
git add -A src/adapters/web/ui/ReviewRail.tsx src/adapters/web/ui/ChunkList.tsx src/adapters/web/ui/styles.css
git commit -m "Rework the board panel into the review rail's four sections"
```

---

### Task 8: `ChunkView.tsx` detail rework

**Files:**
- Modify: `src/adapters/web/ui/ChunkView.tsx`
- Modify: `src/adapters/web/ui/styles.css` (`.chunk-view`, `.region`, `.adjudication`,
  `.decide` rules)

**Interfaces:**
- Consumes: same props as today (`chunks`, `diff`, `reviewing`, `reviewKeys`, `waiting`,
  `verdicts`, `notes`, `onEdit`, `onDecide`), minus `onClose` (no longer an overlay — see
  Step 1) plus two new ones: `onNextFile: (() => void) | null` (null when there is no next
  file to advance to — disables the "Next file" button) and `roundContext: string | null`
  (the "Waiting on you · first of two" / "You sent this back · round 2 of at most 8" line —
  computed by `ReviewPane`, which knows the file's position among outstanding files and the
  review's round number; `ChunkView` just renders whatever string it's given, or nothing).
- Produces: the region-opened gate state (`openedRegions: Set<string>`), local to this
  component — no new prop needed for it since `onDecide`'s existing signature already takes
  the verdict at the moment Approve is clicked, and gating is purely about disabling the
  button until every chunk's key is in `openedRegions`.

- [x] **Step 1: Drop the overlay chrome**

Remove the `<button className="chunk-close">` and its containing assumption that this
renders inside a `.scrim`/`.work` wrapper — `ReviewPane` (Task 9) now renders `ChunkView`
directly in its right column, no overlay. (`FilesPane`'s own file-content preview, Task 11,
does not use `ChunkView` at all — it is a much simpler read-only view; see that task.)

- [x] **Step 2: Region N of M + single-card risk**

Add a region index/count line above each region matching the mockup (`"region 1 of 2 · lines
41–58"`, spec line 151) — computed as `chunks.indexOf(chunk) + 1` of `chunks.length` within
the map already iterating `chunks`. Keep the existing `Adjudication`/`Risk` components as
the single card (per the "drop the claim card" decision) — restyle `Risk`'s risky-text
paragraph into the mockup's card treatment (`padding: var(--space-4); border-radius:
var(--radius-md); background: var(--color-surface); box-shadow: inset 3px 0 0
var(--remove)` when risky) rather than adding a second card.

- [x] **Step 3: "Read it" collapse gate for `none`-risk regions, and the opened-region gate on Approve**

```tsx
const [opened, setOpened] = useState<Set<string>>(new Set())
const markOpened = (key: string) => setOpened((prev) => new Set(prev).add(key))
```

For a chunk whose `analysis?.riskLevel === 'none'`, render the diff collapsed behind a
`"Read it ↓"` button (same pattern `Diff.tsx`'s own `WholeFile`/`FoldedContext` already use
for their own collapse-by-default cases — a local `open` boolean, or reuse `opened.has(key)`
directly as that boolean so opening it also satisfies the gate) with the `tag-neutral`
"nothing to challenge here" label next to it (spec line 187), instead of rendering the `Diff`
inline. For every other risk level, call `markOpened(chunk.key)` once on mount (a chunk you
were shown open needs no explicit "read it" click — only the collapsed, no-risk case does)
via a `useEffect(() => { if (chunk.analysis?.riskLevel !== 'none') markOpened(chunk.key) },
[chunk.key, chunk.analysis])`. Then in the `<Decide>` section, add:

```tsx
const allOpened = outstanding.every((chunk) => opened.has(chunk.key))
```

and pass `disabled={!allOpened}` (in addition to whatever `Decide` already disables Approve
on) plus, when disabled for this reason specifically, the mockup's own copy: `"Approve is
off until you have opened both."` (spec line 190) pluralized/singularized off
`outstanding.length`.

- [x] **Step 4: Header controls — Whole file / Edit these lines / Next file**

Add a header row above the regions (spec lines 130–145): `"Whole file"` toggles between the
per-region diff view (current behavior) and fetching+showing the file's current full content
read-only via the existing `/files/content?path=...` endpoint (same one `FilesPane`/old
`FileTree` already call — no new server route). `"Edit these lines"` scrolls to and opens
the first outstanding chunk's existing `Editor` component (which already exists per-region —
this button is a convenience that finds the first outstanding region's editor toggle and
clicks it programmatically, or simpler: expands all outstanding regions' editors at once by
lifting each `Editor`'s `open` state up into a small `Set<string>` this component owns and
passes down as a prop, defaulting to `Editor`'s own internal state when not driven). Keep
this simple — a single "open every outstanding region's editor" action is enough to match
the button's intent; it does not need to be pixel-identical to a hypothetical single-editor
mode. `"Next file"` calls the new `onNextFile` prop, disabled (and hidden, not shown greyed
out — matching how the mockup only shows it when there is somewhere to go) when
`onNextFile === null`.

- [x] **Step 5: Keyboard shortcuts — A approve, R focus the reject box**

```tsx
useEffect(() => {
  const onKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
    if (event.key === 'a' || event.key === 'A') {
      if (allOpened && outstanding.length > 0) onDecide(outstanding.map((c) => c.key), { verdict: 'approve' })
    }
    if (event.key === 'r' || event.key === 'R') {
      rejectBoxRef.current?.focus()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [allOpened, outstanding, onDecide])
```

(`rejectBoxRef` — a new ref on `Decide`'s `<textarea>`, threaded down as a prop or lifted;
whichever is less invasive given `Decide` is currently a sibling function in the same file
with its own local `feedback` state — simplest is probably moving the `feedback` state up
into `ChunkView` itself so both the ref and the "R" shortcut have something to act on. Use
judgment here; this is the one place in the plan where the exact wiring is left to the
implementer because it depends on how `Decide`'s existing state was structured, which this
plan's author was reading, not writing, at plan time.) Guard against firing while any
textarea/input has focus (typing "r" in the feedback box must not re-focus it).

- [x] **Step 6: Visual + interaction check (deferred to Task 9)**

`ChunkView` has no standalone render target — verified once mounted by `ReviewPane`.

- [x] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: `ChunkView.tsx` typechecks against its new prop signature. `ReviewPane.tsx`
(Task 9, not yet written) will be the only caller — no cross-file errors yet from removing
`onClose`.

- [x] **Step 8: Commit**

```bash
git add src/adapters/web/ui/ChunkView.tsx src/adapters/web/ui/styles.css
git commit -m "Rework the review detail pane: single risk card, region gating, keyboard shortcuts"
```

---

### Task 9: `ReviewPane.tsx`

**Files:**
- New: `src/adapters/web/ui/ReviewPane.tsx`
- Modify: `src/adapters/web/ui/styles.css` (two-column grid, rail header summary, round
  banner)

**Interfaces:**
- Consumes: `ReviewRail` (Task 7), `ChunkView` (Task 8), `SessionState`, `DiffView | null`,
  `ReviewSections` (computed once in `App.tsx`, passed down — do not recompute here).
- Produces: `ReviewPane`, mounted by `App.tsx` (Task 6, built after this).

- [x] **Step 1: Two-column layout, no overlay**

```tsx
export function ReviewPane({
  state,
  diff,
  board,
  waiting,
  reviewing,
}: {
  state: SessionState
  diff: DiffView | null
  board: ReviewSections
  waiting: Waiting
  reviewing: boolean
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const selectedKey = picked ?? state.activeChunk
  const selected = state.chunks.find((c) => c.key === selectedKey) ?? null
  const chunksInFile = selected === null ? [] : state.chunks
    .filter((c) => c.path === selected.path)
    .sort((a, b) => a.startLine - b.startLine)

  // File order for J/K and "Next file": the rail's own visual order — waitingOnYou first,
  // then backWithAgent, approved, passedWithoutReview — deduplicated to one entry per path.
  const fileOrder = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const group of [board.waitingOnYou, board.backWithAgent, board.approved, board.passedWithoutReview]) {
      for (const chunk of group) {
        if (!seen.has(chunk.path)) { seen.add(chunk.path); order.push(chunk.path) }
      }
    }
    return order
  }, [board])

  const advance = (delta: 1 | -1): void => {
    if (selected === null) return
    const at = fileOrder.indexOf(selected.path)
    const next = fileOrder[at + delta]
    if (next !== undefined) {
      const chunk = state.chunks.find((c) => c.path === next)
      if (chunk !== undefined) setPicked(chunk.key)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (event.key === 'j' || event.key === 'J') advance(1)
      if (event.key === 'k' || event.key === 'K') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileOrder, selected])

  const totalFiles = fileOrder.length
  const hasAnything = totalFiles > 0

  return (
    <div className="review-pane">
      <aside className="review-rail-col">
        <header className="rail-summary">
          <p className="rail-summary-count">{totalFiles} file{totalFiles === 1 ? '' : 's'} changed</p>
          <p className="rail-summary-sub">Everything this branch has done to main. Nothing has merged.</p>
        </header>
        {hasAnything ? (
          <ReviewRail
            board={board}
            selected={selectedKey}
            verdicts={state.review?.verdicts ?? {}}
            reviewKeys={state.review?.keys ?? null}
            waiting={waiting}
            onSelect={setPicked}
          />
        ) : (
          <p className="placeholder">Nothing has changed on this branch yet.</p>
        )}
        {reviewing && (state.review?.round ?? 0) > 0 && (
          <p className="rail-round-note">
            Revision round {state.review?.round}. The agent gets your feedback the moment this turn ends.
          </p>
        )}
      </aside>

      <section className="review-detail-col">
        {selected === null ? (
          <p className="placeholder">Nothing selected.</p>
        ) : (
          <ChunkView
            key={selected.path}
            chunks={chunksInFile}
            diff={diff}
            reviewing={reviewing}
            reviewKeys={state.review?.keys ?? null}
            waiting={waiting}
            verdicts={state.review?.verdicts ?? {}}
            roundContext={/* "Waiting on you · first of two" or the sent-back framing — computed from fileOrder position + board */ null}
            notes={{
              annotations: state.annotations.filter((a) => chunksInFile.some((c) => c.key === a.chunkKey)),
              onAdd: (line, side, lineText, body) =>
                void post('/annotate', { chunkKey: selected.key, line, side, lineText, body }),
              onRemove: (id) => void post('/annotation/remove', { id }),
            }}
            onNextFile={fileOrder.indexOf(selected.path) < fileOrder.length - 1 ? () => advance(1) : null}
            onDecide={(chunkKeys, verdict) => {
              for (const chunkKey of chunkKeys) {
                void post('/decision', { chunkKey, verdict: verdict.verdict, ...(verdict.verdict === 'reject' ? { feedback: verdict.feedback } : {}) })
              }
              // Same auto-advance the old App.tsx onDecide had — find the next outstanding
              // chunk anywhere on the board and select it.
              const justDecided = new Set(chunkKeys)
              const verdicts = state.review?.verdicts ?? {}
              const reviewKeys = state.review?.keys ?? null
              const nextChunk = [...state.chunks]
                .filter((c) => !justDecided.has(c.key) && isOutstanding(c, verdicts, reviewKeys))
                .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)[0]
              setPicked(nextChunk?.key ?? null)
            }}
            onEdit={async (chunkKey, expected, replacement) => {
              const response = await fetch('/edit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chunkKey, expected, replacement }),
              }).catch(() => null)
              if (response === null) return { ok: false, reason: 'could not reach ISR' }
              if (response.ok) return { ok: true }
              const failure = (await response.json().catch(() => ({}))) as { error?: string }
              return { ok: false, reason: failure.error }
            }}
          />
        )}
      </section>
    </div>
  )
}
```

This is the largest lift-and-adapt in the plan — most of the body is the existing
`App.tsx` popup-wiring logic (auto-advance on decide, edit posting, annotation filtering),
moved here verbatim with `setClosed`/`showDetail`/scrim handling deleted (no overlay to open
or close in this layout — the right column always shows whatever is selected, or a
placeholder).

- [x] **Step 2: `roundContext` computation**

Fill in the `roundContext` placeholder from Step 1: `"Waiting on you · first of two"` style
when `reviewing && !revising` (position = index of `selected.path` in `board.waitingOnYou`'s
deduplicated file order + 1, of `board.waitingOnYou`'s total file count), or the mockup's
Screen 2 framing (`"You sent this back · round N of at most 8"`) when the file is in
`backWithAgent`. Reuse whatever round-cap constant the app already has (search for
`shouldWarnAboutBlockCap`/a max-rounds constant in `core/adjudication.ts` or `app/gate.ts`
for the "of at most 8" figure — do not hardcode 8 if a real constant exists; if none does,
omit the "of at most N" clause rather than inventing a number).

- [x] **Step 3: Style**

`.review-pane` as `display: grid; grid-template-columns: 296px 1fr; flex: 1; min-height: 0`
(matching the mockup's literal 296px rail width, spec line 55). `.review-rail-col` and
`.review-detail-col` each `overflow-y: auto; min-height: 0`. `.rail-summary`/`.rail-round-
note` per spec lines 58–61 and 123–125.

- [x] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: `ReviewPane.tsx` typechecks against `ReviewRail`/`ChunkView`'s finished prop
shapes from Tasks 7–8. Not yet mounted by `App.tsx` (Task 6 comes after this).

- [x] **Step 5: Commit**

```bash
git add src/adapters/web/ui/ReviewPane.tsx src/adapters/web/ui/styles.css
git commit -m "Add the Review tab: rail and detail as one persistent two-column view"
```

---

### Task 10: `SessionPane.tsx`

**Files:**
- New: `src/adapters/web/ui/SessionPane.tsx`
- Modify: `src/adapters/web/ui/styles.css` (banner, idle-state rules; `.conversation` rules
  mostly carry over unchanged)

**Interfaces:**
- Consumes: `SessionState`, `Waiting`, `reviewing: boolean`, `reviewCount: number`,
  `onReview: () => void` (switches `App.tsx`'s `mode` to `'review'`).
- Produces: `SessionPane`, mounted by `App.tsx` (Task 6).

- [x] **Step 1: Lift the conversation almost verbatim**

Move `Entry`, the `<section className="conversation">` JSX block (header, transcript list,
permissions, queued messages, the prompt form), `submit`, the `turns`/`carrying`/`doing`
computations, the `stuck`/`tail`/`column` scroll-follow refs and their effects, straight out
of the current `App.tsx` into this new file — this content does not change in substance,
only its container.

- [x] **Step 2: Add the "waiting on you" banner**

Above the transcript (spec lines 337–340), when `reviewCount > 0`:

```tsx
{reviewCount > 0 && (
  <div className="session-banner">
    <span>{reviewCount} change{reviewCount === 1 ? ' is' : 's are'} waiting on you while this runs.</span>
    <button type="button" className="btn btn-ghost" onClick={onReview}>
      Review them <kbd>⌘1</kbd>
    </button>
  </div>
)}
```

- [x] **Step 3: Idle empty state**

When `state.status === 'idle' && !reviewing && reviewCount === 0 && state.chunks.length ===
0` (or, more precisely: no *ever* board activity this session — reuse whatever
`hasBoard`-equivalent check makes sense; if the board has settled entries but nothing
outstanding, prefer showing the settled-entries summary from the mockup's Screen 4 over a
bare "nothing yet" message), render the Screen 4 idle layout (spec lines 388–411) instead of
the empty transcript: `"Nothing waiting on you"` / `"Every change on this branch has an
answer."`, a short summary line, and a list of the most-recently-approved files with their
decided time (pull from `state.chunks` filtered to `board === 'approved'`, sorted by
`decidedAt` desc, capped to a handful) — the prompt input still renders below it exactly as
it does when the transcript is showing (this state is a *replacement* for the transcript
area only, not for the compose form).

- [x] **Step 4: Style**

`.session-banner` per spec lines 337–340 (`background: var(--color-accent-900)`, `padding:
var(--space-3) var(--space-6)`). Idle state per spec lines 388–411 (centered column,
`justify-content: center`, the approved-file rows using the same fading-divider background
trick already documented elsewhere in `styles.css` — search for the existing
`linear-gradient(to right, transparent, var(--color-divider)...)` pattern Task 4 preserved
and reuse it rather than inventing a new one).

- [x] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: `SessionPane.tsx` typechecks standalone.

- [x] **Step 6: Commit**

```bash
git add src/adapters/web/ui/SessionPane.tsx src/adapters/web/ui/styles.css
git commit -m "Add the Session tab: conversation, waiting-on-you banner, idle summary"
```

---

### Task 11: `FilesPane.tsx` (replaces `FileTree.tsx`)

**Files:**
- New: `src/adapters/web/ui/FilesPane.tsx`
- Delete: `src/adapters/web/ui/FileTree.tsx`
- Modify: `src/adapters/web/ui/styles.css` (two-column layout, search input, inline
  preview — replacing `.file-tree`'s drawer/resizer/scrim rules)

**Interfaces:**
- Consumes: `SessionState`, `DiffView | null`, `ReviewSections` (to know which open file has
  an outstanding chunk, for the "Review this change" button), `onReviewChunk: (chunkKey:
  string) => void` (switches `App.tsx` to Review mode with that chunk selected — this means
  `App.tsx`'s `mode` state needs to carry an optional "and select this" payload; simplest is
  `const [mode, setMode] = useState<Mode>('review')` plus a separate `const [jumpTo,
  setJumpTo] = useState<string | null>(null)` that `ReviewPane` consumes as an initial
  `picked` value and `App.tsx` clears after handing it off — wire this in Task 6, not here).
- Produces: `FilesPane`, mounted by `App.tsx` (Task 6).

- [x] **Step 1: Reuse `buildFileTree`/`TreeRow`, drop the drawer/scrim/resizer**

Keep `core/filetree.ts`'s `buildFileTree` and the existing `TreeRow` recursive component
from `FileTree.tsx` (`git mv` is not appropriate here since the file is being restructured
substantially — copy `TreeRow` and the `/files` fetch-on-mount effect into `FilesPane.tsx`,
then delete `FileTree.tsx`). Drop `open`/`onClose`/`width`/`onWidthChange`/`resizing`/
`startResize`/the `.scrim` popup wrapper entirely — this pane is always full-width when
`mode === 'files'`, no drawer, no resize handle, no overlay for viewing a file (content
shows inline in the right column instead).

- [x] **Step 2: Search/filter input**

```tsx
const [filter, setFilter] = useState('')
const searchRef = useRef<HTMLInputElement>(null)

useEffect(() => {
  const onKey = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault()
      searchRef.current?.focus()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [])

const filteredPaths = filter.trim() === ''
  ? paths
  : paths?.filter((path) => path.toLowerCase().includes(filter.trim().toLowerCase())) ?? null
```

Feed `buildFileTree(filteredPaths ?? [])` instead of the raw list when rendering the tree.
Input placeholder `"Jump to a file   ⌘K"` per spec line 444.

- [x] **Step 3: Inline content preview + "Review this change" button**

Replace the old scrim-popup `viewing` state's rendering with an inline right column: same
`openFile`/fetch-on-click logic (`/files/content?path=...`), same `requested` ref race guard,
but rendered as the pane's second grid column rather than an overlay (spec lines 481–501):
header with the path, `"whole file · N lines"` (line count from `viewing.text.split('\n
').length`), and — only when the open path has an outstanding chunk in `board.waitingOnYou`
— a `"Review this change ⏎"` button calling `onReviewChunk(chunk.key)` for that file's first
outstanding chunk. Highlight the changed lines in the preview using `diff.files.find(f =>
f.path === viewing.path)?.patch` if present (spec lines 487–499 show specific lines boxed
with `box-shadow: inset 3px 0 0 var(--color-accent); background: var(--color-accent-900)`)
— map the patch's changed line numbers onto the plain-text preview's line numbers; if this
mapping proves fiddly given `viewing.text` is the *current* file (which the patch's new-side
line numbers already correspond to), keep it — this is a straightforward index-by-line-
number join, not a diff computation.

- [x] **Step 4: Row status labels**

Each tree row for a file with board state shows a small label per spec lines 453–459
(`"waiting on you"` in accent, `"approved"` in neutral) — derive from `board` the same way
`ReviewRail` does (a file is "waiting on you" if any of its chunks are in
`board.waitingOnYou`; "approved" if all its chunks are in `board.approved` and none in the
other three groups; otherwise no label).

- [x] **Step 5: Style**

`.files-pane` as `display: grid; grid-template-columns: 296px 1fr; flex: 1; min-height: 0`
(same rail width as the Review tab, matching spec line 448). Tree rows, search input, and
preview header per spec lines 449–501.

- [x] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: `FilesPane.tsx` typechecks standalone; `FileTree.tsx`'s deletion may surface an
import in `App.tsx` still pointing at it — that's expected and fixed in Task 6.

- [x] **Step 7: Commit**

```bash
git add -A src/adapters/web/ui/FilesPane.tsx src/adapters/web/ui/FileTree.tsx src/adapters/web/ui/styles.css
git commit -m "Replace the file tree drawer with the full Files tab"
```

---

### Task 12: Integration, cleanup, and browser verification

**Files:**
- Modify: `src/adapters/web/ui/App.tsx` (actually build Task 6's shell now that Tasks 7–11
  exist — see Task 6's Step 1 note on build order)
- Modify: `src/adapters/web/ui/styles.css` (delete now-dead rules: old `.chunk-list` header/
  view-toggle-in-header styles superseded by Task 7, old `.file-tree`/`.file-tree-resizer`/
  drawer/scrim rules superseded by Task 11, old `.app.files-open` grid rules superseded by
  Task 6)
- No new source files.

- [x] **Step 1: Build `App.tsx` for real**

Do Task 6 now (it was deferred here deliberately — see that task's Step 1). Wire `ReviewPane`
+ `SessionPane` + `FilesPane` + `TopBar` together, including the `jumpTo` hand-off from
`FilesPane`'s "Review this change" button described in Task 11's Interfaces section.

- [x] **Step 2: Delete dead CSS**

Grep `styles.css` for selectors that no longer have a JSX consumer anywhere in
`src/adapters/web/ui/*.tsx` (`.file-tree`, `.file-tree-resizer`, `.file-tree-body`,
`.panel-close`, the old `.chunk-list header .view-toggle` combo now that Task 7 moved that
button, `.app.files-open`, `--file-tree-width` if nothing references it anymore since it may
have moved into `FilesPane`'s own scoped state rather than a CSS custom property once it's
no longer sized via a shared grid column) and delete them.

- [x] **Step 3: Full verification**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all three clean. This is the first point the entire UI compiles and every test
(including the reshaped `groupBoard` tests from Task 3 and the new baseline/diff tests from
Tasks 1–2) passes together.

- [x] **Step 4: Browser verification**

Use the `run` skill (or `bun src/cli/main.ts` directly in a scratch git repo with a pending
agent-made change) to confirm, in an actual browser:
- Review tab: rail shows the four sections correctly populated; selecting a file shows its
  detail on the right with no popup/scrim; approving/rejecting advances to the next
  outstanding file; `J`/`K` move between files; `A` approves once every region is opened;
  `R` focuses the reject box; a `none`-risk region starts collapsed behind "Read it" and
  Approve is disabled until it's opened.
- Session tab: conversation renders as before; the "N changes waiting on you" banner appears
  when the Review tab has outstanding items and its button switches tabs; the idle state
  renders when nothing is outstanding and no turn is running.
- Files tab: tree renders, search filters it, `⌘K` focuses the search box, opening a file
  shows its content inline (not a popup), and a file with an outstanding chunk shows "Review
  this change" wired to jump to the Review tab on that file.
- `⌘1`/`⌘2`/`⌘3` switch tabs from anywhere except while typing in a text field.
- Dark theme renders correctly (Nocturne palette, Inter body font, monospace preserved on
  code/paths).

This step has no automated assertion — record what was checked and any deviations found
against this checklist directly to the user, not to a file.

- [x] **Step 5: Commit**

```bash
git add -A src/adapters/web/ui/App.tsx src/adapters/web/ui/styles.css
git commit -m "Wire the three-tab shell together and remove dead board/drawer CSS"
```

## Self-Review Notes (from the plan's own author, before execution)

- **Spec coverage:** Screen 1 (Review, hero) → Tasks 7–9. Screen 2 (sent back) →
  `roundContext`/`backWithAgent` handling in Tasks 3, 8, 9. Screen 3 (Session working) →
  Task 10 Steps 1–2. Screen 4 (Idle) → Task 10 Step 3 (assigned to the Session tab per the
  Global Constraints note on the mockup's tab-underline inconsistency). Screen 5 (Files) →
  Task 11. Top bar (all screens) → Task 5. Design tokens/typography → Task 4. The two small
  data additions (branch name, diff totals) the header needs → Tasks 1–2.
- **Explicit cuts** (claim card, ⌘K palette, `N` shortcut, Activity log's new home) are
  recorded in Global Constraints so they read as decisions, not oversights, when this plan
  is reviewed later.
- **Type consistency check:** `ReviewSections` (Task 3) is the type every later task's
  `board` prop is threaded from — Tasks 7, 9, 11 all consume the same four field names
  (`waitingOnYou`/`backWithAgent`/`approved`/`passedWithoutReview`); confirmed no task
  reintroduces the old `attention`/`archive` names.
