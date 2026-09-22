# Stage 4 — Retire the git `RootRegistry` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the git-backed `RootRegistry` (`adapters/git/rootRegistry.ts` +
`rootDiscovery.ts`) and the `detection` config flag that chose between it and the
already-default watcher implementation, so the live app has exactly one change-detection
mechanism — matching Stage 4 of the original watcher migration, which deliberately deferred
this until "the watcher path has soaked in real use."

**Architecture:** `cli/app.ts`'s composition root collapses from `config.detection === 'watcher'
? createWatcherRootRegistry(...) : createGitRootRegistry(...)` to an unconditional
`createWatcherRootRegistry(...)` call. `adapters/git/rootRegistry.ts` and `rootDiscovery.ts` (the
files that implement the git `RootRegistry` and its real-`.git`-ancestor walk) are deleted along
with their tests. The four other git adapter files — `baseline.ts`, `commands.ts`, `delta.ts`,
`snapshots.ts` — are **not** deleted: `cli/main.ts`'s standalone `status`/`prune`/`reset`
commands import them directly, independently of the live app's `RootRegistry` choice, and stay
git-only exactly as Stage 3 already established. `tests/app/gate.test.ts` — the full-pipeline
test suite, which today constructs a real `createGitRootRegistry` directly rather than reading
the (now-deleted) config default — moves onto `createWatcherRootRegistry`, dropping the two test
scenarios whose defect is structurally impossible once there is no git plumbing left in the live
pipeline to produce it (a self-commit racing the baseline via git's own HEAD; a nested `.git`
hiding a path behind a gitlink boundary).

**Tech Stack:** TypeScript, Bun (`bun:test`), Zod (config schema). No new dependencies; no port
(`core/ports.ts`) changes — `RootRegistry`/`SnapshotStore`/`Baseline` keep the exact shape both
adapter families already satisfy.

**Spec:** `~/.claude/plans/quiet-wobbling-neumann.md` (the original four-stage watcher migration
plan; this plan implements its "Stage 4 — explicitly out of scope for this plan" section, which
named only `adapters/git/rootRegistry.ts`/`rootDiscovery.ts` and the `detection` flag — not the
whole `adapters/git/*` family).

## Global Constraints

- Every task must leave `bun run typecheck && bun test && bun run lint` clean before it's done —
  not just at the end. This is a deletion/refactor plan, not new-feature work, so "TDD" here
  means "run the affected tests, then the full suite, before and after every change" rather than
  literal red-green-refactor on brand-new code.
- `adapters/git/{baseline,commands,delta,snapshots}.ts` and their existing unit tests
  (`tests/adapters/git/{baseline,delta,snapshots}.test.ts`) are explicitly **out of scope** for
  deletion. `cli/main.ts`'s standalone commands depend on them directly and stay git-only
  forever — an already-settled Stage 3 decision, not being revisited here.
- Every code comment that names a file this plan deletes (`adapters/git/rootRegistry.ts`,
  `adapters/git/rootDiscovery.ts`) must be updated, not left pointing at a path that no longer
  exists.
- No git commit history is rewritten or force-pushed; this plan only edits working-tree files.

---

### Task 1: Migrate `tests/app/gate.test.ts` off the git `RootRegistry`

Self-contained and revertible on its own: `adapters/git/rootRegistry.ts` still exists,
untouched, on disk after this task — only this test file's construction of it changes. This has
to land *before* Task 3 deletes that file, since this is the one place outside
`adapters/git/*`'s own tests that constructs it directly.

**Files:**
- Modify: `tests/app/gate.test.ts`

**Interfaces:**
- Consumes: `createWatcherRootRegistry` (`src/adapters/watcher/rootRegistry.ts`, options
  `{ primaryRoot, excludePrefixes, ledger, chunkOrigins, sessions }` → `Promise<RootRegistry>`),
  `createTreeCache` (`src/adapters/watcher/treeCache.ts`, `(root, ignoreFn) => TreeCache`),
  `createIgnoreMatcher` (`src/adapters/watcher/ignore.ts`, `(root, excludePrefixes) => (path,
  isDir) => boolean`), `createPersistedSnapshots` (`src/adapters/watcher/persist.ts`, `(root) =>
  PersistedSnapshots`), `createWatcherSnapshotStore` (`src/adapters/watcher/snapshotStore.ts`,
  `({ treeCache, persist }) => SnapshotStore & { hasManifest }`), `createWatcherBaseline`
  (`src/adapters/watcher/baseline.ts`, `({ hasManifest }) => Baseline`).
- Produces: nothing new for other tasks — this is a leaf change.

- [ ] **Step 1: Run the file once to record the current baseline**

  Run: `bun test tests/app/gate.test.ts`
  Expected: all tests pass (this is today's baseline, against real git — confirm before
  touching anything).

- [ ] **Step 2: Swap the imports**

  Replace:
  ```ts
  import { createGitBaseline } from '../../src/adapters/git/baseline.ts'
  import { git } from '../../src/adapters/git/commands.ts'
  import { createGitRootRegistry } from '../../src/adapters/git/rootRegistry.ts'
  import { createGitSnapshotStore } from '../../src/adapters/git/snapshots.ts'
  ```
  with:
  ```ts
  import { createGitBaseline } from '../../src/adapters/git/baseline.ts'
  import { git } from '../../src/adapters/git/commands.ts'
  import { createIgnoreMatcher } from '../../src/adapters/watcher/ignore.ts'
  import { createWatcherBaseline } from '../../src/adapters/watcher/baseline.ts'
  import { createPersistedSnapshots } from '../../src/adapters/watcher/persist.ts'
  import { createWatcherRootRegistry } from '../../src/adapters/watcher/rootRegistry.ts'
  import { createWatcherSnapshotStore } from '../../src/adapters/watcher/snapshotStore.ts'
  import { createTreeCache } from '../../src/adapters/watcher/treeCache.ts'
  ```
  (`createGitBaseline` and `git` stay — `currentBranch()` below still resolves the repo's real
  git branch for `ChunkOrigin`/`ChunkReview`'s informational `branch` field, which is populated
  the same way regardless of which `RootRegistry` is live; `git` is also still used by
  `beforeEach` and by unrelated fixture setup elsewhere in the file. `createGitRootRegistry` and
  `createGitSnapshotStore` are the two imports that go away.)

- [ ] **Step 3: Add a `watcherStoreFor` test helper, right after `rootsFor`**

  Replace:
  ```ts
  /** A single-root `RootRegistry`, seeded exactly the way `cli/app.ts` seeds the real one — the
   *  same `ledger`/`chunkOrigins`/`sessions` `runTurn` already builds, wired through so
   *  coalescing/migration would work the same way in a real process. */
  async function rootsFor(
    cwd: string,
    ledger: ReviewLedger,
    chunkOrigins: ChunkOrigins,
    sessions: SessionStore,
  ): Promise<RootRegistry> {
    const roots = await createGitRootRegistry({
      primaryRoot: cwd,
      trunk: null,
      excludePrefixes: [STATE_DIR],
      ledger,
      chunkOrigins,
      sessions,
    })
    await roots.resolveRootFor('startup', cwd)
    return roots
  }
  ```
  with:
  ```ts
  /** A single-root `RootRegistry`, seeded exactly the way `cli/app.ts` seeds the real one — the
   *  same `ledger`/`chunkOrigins`/`sessions` `runTurn` already builds, wired through so
   *  coalescing/migration would work the same way in a real process. Watcher-backed, matching
   *  the only `RootRegistry` the live app ever wires up now (see `cli/app.ts`) — the git-backed
   *  one is still real (`adapters/git/rootRegistry.ts`) but reachable only from its own unit
   *  tests under `tests/adapters/git/*`, not from here any more. */
  async function rootsFor(
    cwd: string,
    ledger: ReviewLedger,
    chunkOrigins: ChunkOrigins,
    sessions: SessionStore,
  ): Promise<RootRegistry> {
    const roots = await createWatcherRootRegistry({
      primaryRoot: cwd,
      excludePrefixes: [STATE_DIR],
      ledger,
      chunkOrigins,
      sessions,
    })
    await roots.resolveRootFor('startup', cwd)
    return roots
  }

  /** The same `SnapshotStore`/`Baseline` pair `rootsFor`'s `RootRegistry` builds internally for
   *  `repo`, constructed directly for the handful of tests that need to call `capture()`/
   *  `resolve()` themselves rather than going through a full `runTurn()`. */
  function watcherStoreFor(cwd: string) {
    const treeCache = createTreeCache(cwd, createIgnoreMatcher(cwd, [STATE_DIR]))
    const persist = createPersistedSnapshots(cwd)
    const snapshots = createWatcherSnapshotStore({ treeCache, persist })
    const baseline = createWatcherBaseline({ hasManifest: snapshots.hasManifest })
    return { snapshots, baseline }
  }
  ```

- [ ] **Step 4: Convert the two mechanical call sites**

  At (today's) line 311, inside `describe('board pinning', ...)`, replace:
  ```ts
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })
  ```
  with:
  ```ts
    const { snapshots } = watcherStoreFor(repo)
  ```

  At (today's) lines 1251-1252, inside the precomputed-analysis describe block, replace:
  ```ts
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })
    const baseline = createGitBaseline({ cwd: repo, trunk: null })
  ```
  with:
  ```ts
    const { snapshots, baseline } = watcherStoreFor(repo)
  ```

- [ ] **Step 5: Delete the one test whose defect is git-HEAD-specific, and fix the rest of its
      describe block**

  In `describe('an agent that commits its own work', ...)`, delete the first test entirely:
  ```ts
  test('without a recorded baseline, a self-commit slips through unreviewed', async () => {
    await write('src/app.ts', 'export const value = 2\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'agent commits its own work'])

    // No baseline recorded — the old behavior.
    const { ui } = await runTurn()
    expect(ui.seen).toEqual([])
  })
  ```
  This exact scenario — an unrecorded baseline falling back to `HEAD`, which a mid-turn commit
  has already moved past the agent's own edit — is structurally impossible once the live
  pipeline never uses git for its `RootRegistry`/`SnapshotStore`/`Baseline`: watcher's baseline
  (`adapters/watcher/baseline.ts`) never resolves against `HEAD` at all, only session-start or
  empty. The equivalent git-level assertion already exists at
  `tests/adapters/git/baseline.test.ts:145`, `'so an agent committing on trunk cannot hide its
  work'` — that coverage stays, unaffected by this plan, since `baseline.ts` isn't being deleted.

  Rewrite the remaining tests in the same describe block, replacing every
  `createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })` with
  `watcherStoreFor(repo)` (destructuring `{ snapshots }` or `{ snapshots, baseline }` as each
  test needs) and dropping the now-vestigial `git(repo, ['add', '-A'])` /
  `git(repo, ['commit', ...])` pairs that follow a `write()` call in this block — under watcher
  those commits change nothing observable, and keeping them would wrongly imply commit timing
  still matters here:

  Replace:
  ```ts
  test('with a baseline recorded first, the same commit is still reviewed', async () => {
    const sessions = createFileSessionStore(repo)
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })
    await sessions.recordBaseline('sess-1', repo, await snapshots.capture())

    await write('src/app.ts', 'export const value = 2\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'agent commits its own work'])

    const { ui } = await runTurn()
    expect(ui.seen.length).toBe(1)
    expect(ui.seen[0]?.payload.changeClusters.map((c) => c.diffLocation.file)).toEqual([
      'src/app.ts',
    ])
  })
  ```
  with:
  ```ts
  test('with a baseline recorded first, a later edit is still reviewed', async () => {
    const sessions = createFileSessionStore(repo)
    const { snapshots } = watcherStoreFor(repo)
    await sessions.recordBaseline('sess-1', repo, await snapshots.capture())

    await write('src/app.ts', 'export const value = 2\n')

    const { ui } = await runTurn()
    expect(ui.seen.length).toBe(1)
    expect(ui.seen[0]?.payload.changeClusters.map((c) => c.diffLocation.file)).toEqual([
      'src/app.ts',
    ])
  })
  ```

  Replace:
  ```ts
  test('a baseline is not recorded twice, so it cannot advance over the agent', async () => {
    const sessions = createFileSessionStore(repo)
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })

    const first = await snapshots.capture()
  ```
  with:
  ```ts
  test('a baseline is not recorded twice, so it cannot advance over the agent', async () => {
    const sessions = createFileSessionStore(repo)
    const { snapshots } = watcherStoreFor(repo)

    const first = await snapshots.capture()
  ```
  (rest of that test body is unchanged).

  Replace:
  ```ts
  test('the anchor survives being re-recorded under the same session id', async () => {
    const sessions = createFileSessionStore(repo)
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })
    const baseline = createGitBaseline({ cwd: repo, trunk: null })

    const genesis = await snapshots.capture()
  ```
  with:
  ```ts
  test('the anchor survives being re-recorded under the same session id', async () => {
    const sessions = createFileSessionStore(repo)
    const { snapshots, baseline } = watcherStoreFor(repo)

    const genesis = await snapshots.capture()
  ```
  (rest of that test body is unchanged).

  Replace:
  ```ts
  test('an unrecognised baseline falls back to HEAD rather than failing', async () => {
  ```
  with:
  ```ts
  test('an unrecognised baseline falls back to empty rather than failing', async () => {
  ```
  (body unchanged — it never constructs a git snapshot/baseline directly, it only calls
  `sessions.recordBaseline('sess-1', repo, 'deadbeef...')` with a made-up id and checks the turn
  still gets reviewed; under watcher an unrecognised id falls back to the empty-tree snapshot
  rather than `HEAD`, but the observable assertion — the write still reaches review — holds
  either way, so only the name needs to stop claiming "HEAD").

  Replace:
  ```ts
  test('acceptance resets the round counter but keeps the baseline', async () => {
    const sessions = createFileSessionStore(repo)
    const snapshots = createGitSnapshotStore({ cwd: repo, excludePrefixes: [STATE_DIR] })
    const recorded = await snapshots.capture()
  ```
  with:
  ```ts
  test('acceptance resets the round counter but keeps the baseline', async () => {
    const sessions = createFileSessionStore(repo)
    const { snapshots } = watcherStoreFor(repo)
    const recorded = await snapshots.capture()
  ```
  (rest of that test body is unchanged).

- [ ] **Step 6: Delete the whole "nested repo mid-session" describe block**

  Delete `describe('a subdirectory that becomes its own nested repo mid-session', () => { ... })`
  in its entirety (both tests inside it). Its premise — a primary root's git-computed delta
  hiding a path behind a gitlink boundary when a subdirectory becomes its own real git repo
  mid-session (`adapters/git/delta.ts`'s `isPathBehindGitlink`) — cannot occur once the live
  pipeline's `RootRegistry` never produces a git-computed delta at all: watcher's `TreeCache`
  walks the literal filesystem and simply excludes `.git` at any depth (`adapters/watcher/
  ignore.ts`); a nested `.git` appearing mid-session changes nothing about whether watcher can
  see the plain files underneath it, so there is no gitlink-boundary failure mode for this test
  to guard against in the pipeline this file now exercises. `adapters/git/delta.ts` itself is
  unchanged and untested by this deletion in any new way — it was never covered anywhere except
  through this now-removed scenario plus its own dedicated `tests/adapters/git/delta.test.ts`,
  which is unaffected by this plan.

- [ ] **Step 7: Update the file's own top-of-file doc comment**

  Replace:
  ```ts
  /**
   * The pipeline against a real git adapter but a fake UI and model.
   *
   * Real git because the checkpoint semantics — the moving baseline, revise-forward,
   * non-invasiveness — are the behavior most worth protecting, and a fake store would
   * prove nothing about them. Fake UI and model because neither a browser nor the network
   * belongs in a test.
   */
  ```
  with:
  ```ts
  /**
   * The pipeline against the real, production watcher adapter, but a fake UI and model.
   *
   * Real watcher (not a fake `SnapshotStore`/`Baseline`) because the checkpoint semantics — the
   * moving baseline, revise-forward, non-invasiveness — are the behavior most worth protecting,
   * and a fake store would prove nothing about them. This is the only `RootRegistry` the live
   * app ever wires up (`cli/app.ts`) since the git-backed one was retired — `adapters/git/
   * {baseline,commands,delta,snapshots}.ts` are still real and still used directly by
   * `cli/main.ts`'s standalone `status`/`prune`/`reset` commands, and stay covered by their own
   * unit tests under `tests/adapters/git/*`, just not exercised through this pipeline any more.
   * Fake UI and model because neither a browser nor the network belongs in a test. `beforeEach`
   * still gives every test a real git-initialized `repo` — `currentBranch()` below still
   * resolves it directly through git for `ChunkOrigin`/`ChunkReview`'s informational `branch`
   * field, which stays populated the same way regardless of which detection mechanism is live.
   */
  ```

- [ ] **Step 8: Run the file, then the full suite**

  Run: `bun test tests/app/gate.test.ts`
  Expected: PASS, same test count as Step 1 minus the 3 deleted tests (1 from Step 5, 2 from
  Step 6).

  Run: `bun run typecheck && bun test && bun run lint`
  Expected: all clean. `adapters/git/rootRegistry.ts` still exists on disk and is now
  referenced only by `cli/app.ts` and its own tests under `tests/adapters/git/*` — confirm with:

  Run: `grep -rn "adapters/git/rootRegistry\|adapters/git/rootDiscovery" tests/ --include="*.ts"`
  Expected: no matches outside `tests/adapters/git/`.

- [ ] **Step 9: Commit**

  ```bash
  git add tests/app/gate.test.ts
  git commit -m "Migrate gate.test.ts off the git RootRegistry, onto watcher"
  ```

---

### Task 2: Collapse `cli/app.ts` to a single, watcher-only `RootRegistry`, and drop `detection` from config

**Files:**
- Modify: `src/cli/app.ts`
- Modify: `src/core/config.ts`

**Interfaces:**
- Consumes: `createWatcherRootRegistry` (unchanged, already used by Task 1).
- Produces: nothing new — `TurnstileConfig` loses the `detection` field; anything reading
  `config.detection` (only `cli/app.ts` itself, confirmed by
  `grep -rn "config\.detection" src/`) must be gone after this task.

- [ ] **Step 1: Confirm the only real reader of `config.detection`**

  Run: `grep -rn "config\.detection\|detection:\|detection ===" src tests --include="*.ts" --include="*.tsx"`
  Expected: three hits — `src/core/config.ts`'s schema field, `src/cli/app.ts`'s conditional,
  and one unrelated comment in `src/cli/main.ts` (`// ...tracked under detection: 'watcher'...`)
  that doesn't read the field at all. If this turns up anything else (a Settings UI control, a
  sqlite mirror column, a test asserting `detection: 'git'`), stop and re-scope this task before
  continuing — this plan assumes there is nothing else.

- [ ] **Step 2: Remove the `detection` field from the config schema**

  In `src/core/config.ts`, replace:
  ```ts
    trunk: z.string().min(1).nullable().default(null),
    /**
     * How Turnstile finds out what changed. `'watcher'` (the default) scans the working tree
     * directly (`adapters/watcher/*`) and never touches git at all; `'git'` snapshots it through
     * git plumbing instead, real or Turnstile-owned — kept fully intact and selectable as the
     * rollback path, not on a deletion roadmap on any particular timeline. Both satisfy the exact
     * same `RootRegistry`/`SnapshotStore`/`Baseline` ports, so nothing above `cli/app.ts`'s
     * composition root branches on which is chosen.
     */
    detection: z.enum(['git', 'watcher']).default('watcher'),
    riskBar: RiskBarConfigSchema.default({
  ```
  with:
  ```ts
    trunk: z.string().min(1).nullable().default(null),
    riskBar: RiskBarConfigSchema.default({
  ```
  A `.turnstile/config.json` from before this change that still sets `"detection": "git"` or
  `"detection": "watcher"` degrades silently — Zod strips unknown keys by default (this schema
  is not `.strict()`), matching this project's existing precedent for a dropped config/ledger
  field reading back as absent rather than throwing.

- [ ] **Step 3: Run config tests**

  Run: `bun test tests/core/config.test.ts`
  Expected: PASS — `DEFAULT_CONFIG` is derived by parsing through `ConfigSchema`
  (`ConfigSchema.parse({...})`), so it loses the field automatically and
  `expect(await loadConfig(dir, home)).toEqual(DEFAULT_CONFIG)` (the test asserting the full
  default shape) stays correct with no test-file edit needed.

- [ ] **Step 4: Collapse the composition root**

  In `src/cli/app.ts`, remove this import:
  ```ts
  import { createGitRootRegistry } from '../adapters/git/rootRegistry.ts'
  ```

  Then replace:
  ```ts
    // Discovers/tracks every root the session touches — starting with the primary one, seeded
    // here rather than special-cased: `cwd` not being a git repo used to be a hard exit
    // (`isAvailable()` check) before this existed. Now it's just root #1 discovered the same
    // way any other root is. Which mechanism does the discovering is the one thing
    // `config.detection` picks between — both satisfy the same `RootRegistry` port, so nothing
    // past this block knows or cares which one is live. `'git'` mints a synthetic (Turnstile-
    // owned detached git database) root when `cwd` isn't itself a real repo; `'watcher'` never
    // has that distinction at all (see `adapters/watcher/rootRegistry.ts`).
    const roots = await (config.detection === 'watcher'
      ? createWatcherRootRegistry({
          primaryRoot: cwd,
          excludePrefixes: [STATE_DIR],
          ledger,
          chunkOrigins,
          sessions,
        })
      : createGitRootRegistry({
          primaryRoot: cwd,
          trunk: config.trunk,
          excludePrefixes: [STATE_DIR],
          ledger,
          chunkOrigins,
          sessions,
        }))
    await roots.resolveRootFor('startup', cwd)
  ```
  with:
  ```ts
    // Discovers/tracks every root the session touches — starting with the primary one, seeded
    // here rather than special-cased: `cwd` not being a git repo used to be a hard exit
    // (`isAvailable()` check) before this existed. Now it's just root #1 discovered the same
    // way any other root is, via the watcher-backed `RootRegistry` — the only implementation
    // the live app wires up since the git-backed one (which used to mint a synthetic, Turnstile-
    // owned detached git database when `cwd` wasn't itself a real repo) was retired. `adapters/
    // git/{baseline,commands,delta,snapshots}.ts` are still real, still used directly by
    // `cli/main.ts`'s standalone `status`/`prune`/`reset` commands — just no longer reachable
    // through this composition root.
    const roots = await createWatcherRootRegistry({
      primaryRoot: cwd,
      excludePrefixes: [STATE_DIR],
      ledger,
      chunkOrigins,
      sessions,
    })
    await roots.resolveRootFor('startup', cwd)
  ```
  (`config.trunk` is still read elsewhere — `cli/main.ts`'s standalone commands still pass it to
  `createGitBaseline` — so the field itself stays in the config schema; only its use *here*
  goes away.)

  Also replace the now-inaccurate teardown comment further down:
  ```ts
    // Async: `roots.teardown()` drops whatever shouldn't outlive this run — see `RootRegistry`'s
    // own doc comment on `teardown()` for what that means per detection mechanism (a synthetic
    // git root's owned database, ledger/origin records, and recorded baseline; nothing at all
    // under the watcher path).
  ```
  with:
  ```ts
    // Async: `roots.teardown()` drops whatever shouldn't outlive this run — see `RootRegistry`'s
    // own doc comment on `teardown()`. Nothing needs dropping under the watcher-backed
    // `RootRegistry` this composition root always builds now.
  ```

- [ ] **Step 5: Run the full suite**

  Run: `bun run typecheck && bun test && bun run lint`
  Expected: all clean. At this point nothing in `src/` outside `adapters/git/rootRegistry.ts`
  itself and `cli/main.ts` (which never imported it) references `createGitRootRegistry` — the
  file is dead code, about to be deleted in Task 3.

  Run: `grep -rln "createGitRootRegistry\|findNearestRealGitAncestor" src tests --include="*.ts"`
  Expected: only `src/adapters/git/rootRegistry.ts` (defines both),
  `src/adapters/git/rootDiscovery.ts` (defines the latter),
  `tests/adapters/git/rootRegistry.test.ts`, and `tests/adapters/git/rootDiscovery.test.ts`.

- [ ] **Step 6: Commit**

  ```bash
  git add src/cli/app.ts src/core/config.ts
  git commit -m "Collapse the live app to a single, watcher-only RootRegistry"
  ```

---

### Task 3: Delete the git `RootRegistry` implementation and fix dangling references

**Files:**
- Delete: `src/adapters/git/rootRegistry.ts`
- Delete: `src/adapters/git/rootDiscovery.ts`
- Delete: `tests/adapters/git/rootRegistry.test.ts`
- Delete: `tests/adapters/git/rootDiscovery.test.ts`
- Modify: `src/core/ports.ts` (4 doc-comment references)
- Modify: `src/core/rootPaths.ts` (2 doc-comment references)
- Modify: `src/adapters/watcher/rootRegistry.ts` (1 doc-comment reference)

**Interfaces:** none — this task removes code, it introduces nothing new for later tasks.

- [ ] **Step 1: Delete the four files**

  ```bash
  git rm src/adapters/git/rootRegistry.ts src/adapters/git/rootDiscovery.ts
  git rm tests/adapters/git/rootRegistry.test.ts tests/adapters/git/rootDiscovery.test.ts
  ```

- [ ] **Step 2: Run typecheck to find every dangling reference**

  Run: `bun run typecheck`
  Expected: no compile errors (Task 1 and Task 2 already removed every real `import` of these
  two files — this step is a mechanical confirmation, not expected to surface new breakage).

  Run: `grep -rn "adapters/git/rootRegistry\.ts\|adapters/git/rootDiscovery\.ts" src --include="*.ts"`
  Expected: matches only inside doc comments (never a live `import`) — fix each below.

- [ ] **Step 3: Fix the dangling doc comments in `src/core/ports.ts`**

  Replace:
  ```ts
   * `root` is always an absolute path. Used to also carry a `synthetic` flag (true when no real
   * `.git` was found above it, meaning `snapshots`/`baseline` operated against a git database
   * Turnstile owned rather than a real repository — see `adapters/git/rootRegistry.ts`). Dropped
   * once a second detection mechanism (`adapters/watcher/rootRegistry.ts`) existed with no
   * equivalent distinction to draw at all: nothing outside `adapters/git/rootRegistry.ts` itself
   * ever genuinely needed to branch on it (no UI consumer — confirmed by grep before removing
   * it), so it was adapter-internal bookkeeping wearing a shared-type costume. Whichever concrete
   * `RootRegistry` is active keeps whatever it needs to know about a root's own nature to itself.
  ```
  with:
  ```ts
   * `root` is always an absolute path. Used to also carry a `synthetic` flag (true when no real
   * `.git` was found above it, meaning `snapshots`/`baseline` operated against a git database
   * Turnstile owned rather than a real repository — the now-removed git-backed `RootRegistry`,
   * before Stage 4 of the watcher migration deleted it). Dropped once a second detection
   * mechanism (`adapters/watcher/rootRegistry.ts`) existed with no equivalent distinction to
   * draw at all: nothing outside that git adapter itself ever genuinely needed to branch on it
   * (no UI consumer — confirmed by grep before removing it), so it was adapter-internal
   * bookkeeping wearing a shared-type costume. Whichever concrete `RootRegistry` is active keeps
   * whatever it needs to know about a root's own nature to itself.
  ```

  Replace:
  ```ts
   * Starts with just the primary root (the directory Turnstile was launched against — no longer
   * required to be a real git repo) and grows as `propose_edit` calls land on paths outside every
   * currently known root. See `session.ts`'s `runToolWrite` for the one call site that drives
   * discovery. How a root is actually found/minted is entirely up to the concrete adapter —
   * `adapters/git/rootRegistry.ts` walks up for a real `.git`, minting a Turnstile-owned one when
   * there isn't one; `adapters/watcher/rootRegistry.ts` has no such walk at all — this interface
   * only commits to the observable contract below.
  ```
  with:
  ```ts
   * Starts with just the primary root (the directory Turnstile was launched against — no longer
   * required to be a real git repo) and grows as `propose_edit` calls land on paths outside every
   * currently known root. See `session.ts`'s `runToolWrite` for the one call site that drives
   * discovery. `adapters/watcher/rootRegistry.ts` is the only concrete implementation the live
   * app wires up now — no `.git`-ancestor walk at all, just "is this path already inside a
   * known root." A git-backed implementation used to walk up for a real `.git`, minting a
   * Turnstile-owned one when there wasn't one; it was retired in Stage 4 of the watcher
   * migration once the watcher path had soaked in real use.
  ```

  Replace:
  ```ts
   * Called once, at shutdown. Drops whatever a root's own nature says should not outlive this
   * app run — for `adapters/git/rootRegistry.ts`, a synthetic root's owned git database and its
   * `ReviewLedger`/`ChunkOrigins` records (any `SessionStore` baselines recorded for it are left
   * alone: a baseline is per-conversation now, and the owned database they'd resolve against is
   * already gone); for `adapters/watcher/rootRegistry.ts`, nothing at all — every tracked root
   * behaves like a real git root already did (long-lived, nothing forgotten at exit). A real git
   * root's `.git` is never touched either way — it isn't Turnstile's to delete.
  ```
  with:
  ```ts
   * Called once, at shutdown. Drops whatever a root's own nature says should not outlive this
   * app run — for `adapters/watcher/rootRegistry.ts`, the only implementation left, nothing at
   * all: every tracked root is long-lived, nothing forgotten at exit. The git-backed
   * implementation this used to also describe (a synthetic root's owned git database and its
   * `ReviewLedger`/`ChunkOrigins` records) was retired in Stage 4 of the watcher migration.
  ```

- [ ] **Step 4: Fix the dangling doc comments in `src/core/rootPaths.ts`**

  Replace:
  ```ts
   * Every path here is assumed absolute and already normalized. The `.git`-walking that finds
   * candidate roots on disk, and the registry that owns the actual root list, live in
   * `adapters/git/` — this file only answers "given these paths, what's the relationship".
  ```
  with:
  ```ts
   * Every path here is assumed absolute and already normalized. The registry that owns the
   * actual root list lives in `adapters/watcher/rootRegistry.ts` (the live app's only
   * `RootRegistry` since Stage 4 of the watcher migration retired the git-backed one, which used
   * to walk `.git` ancestors on disk) — this file only answers "given these paths, what's the
   * relationship".
  ```

  Replace:
  ```ts
   * Used only for matching against already-known *synthetic* roots, which have no `.git` on
   * disk to walk up to (see `adapters/git/rootDiscovery.ts` for the real-git-ancestor walk that
   * handles the other case). "Deepest" is what makes this correct after a coalescing merge
   * folds a shallower root over a deeper one: the deeper root stops being registered, so the
   * shallower one is the only remaining match.
  ```
  with:
  ```ts
   * Used for matching against every already-known root — `adapters/watcher/rootRegistry.ts`
   * (the only `RootRegistry` left) has no `.git`-ancestor walk to fall back on at all, so this
   * is the whole of its discovery. "Deepest" is what makes this correct after a coalescing merge
   * folds a shallower root over a deeper one: the deeper root stops being registered, so the
   * shallower one is the only remaining match.
  ```

- [ ] **Step 5: Fix the dangling doc comment in `src/adapters/watcher/rootRegistry.ts`**

  Replace:
  ```ts
   * `ledger`/`chunkOrigins`/`sessions` are taken as port types only, never a concrete
   * `adapters/fs/*` import — same discipline `adapters/git/rootRegistry.ts` follows, and for the
   * same reason: this module belongs to the `watcher` adapter family, and
   * `tests/architecture.test.ts` refuses an adapter that imports a sibling family.
  ```
  with:
  ```ts
   * `ledger`/`chunkOrigins`/`sessions` are taken as port types only, never a concrete
   * `adapters/fs/*` import — this module belongs to the `watcher` adapter family, and
   * `tests/architecture.test.ts` refuses an adapter that imports a sibling family.
  ```

- [ ] **Step 6: Confirm no dangling references remain, and run the full suite**

  Run: `grep -rn "adapters/git/rootRegistry\.ts\|adapters/git/rootDiscovery\.ts" src tests --include="*.ts"`
  Expected: no matches at all.

  Run: `bun run typecheck && bun test && bun run lint`
  Expected: all clean.

  Run: `bun run knip 2>&1 | grep -i "rootRegistry\|rootDiscovery"`
  Expected: no output — nothing should flag either deleted file as an orphan that knip still
  half-remembers (a stale reference in `knip.json` itself, if any existed, would be the only way
  this could show something; confirmed earlier in scoping this plan that it doesn't).

- [ ] **Step 7: Commit**

  ```bash
  git add -A
  git commit -m "Delete the git-backed RootRegistry (rootRegistry.ts, rootDiscovery.ts)"
  ```

---

### Task 4 (optional cleanup): Drop the now-unused `env` override plumbing from the remaining git adapter files

Only `adapters/git/rootRegistry.ts`'s `bootstrapSynthetic` ever passed a non-default `env` (to
point a synthetic root's git commands at its own owned `GIT_DIR`/`GIT_WORK_TREE`). With that
file deleted in Task 3, every remaining caller of `commands.ts`/`baseline.ts`/`snapshots.ts` —
`cli/main.ts` and their own unit tests — calls them with no `env` argument at all. This task is
optional: skip it if minimizing diff matters more than removing now-dead parameters. Nothing
depends on it; no other task in this plan requires it.

**Files:**
- Modify: `src/adapters/git/commands.ts`
- Modify: `src/adapters/git/baseline.ts`
- Modify: `src/adapters/git/snapshots.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `git`/`gitOrThrow` (`commands.ts`), every exported function in `baseline.ts` and
  `snapshots.ts`, all lose their trailing `env?: Record<string, string>` parameter. `cli/main.ts`
  and every test under `tests/adapters/git/{baseline,delta,snapshots}.test.ts` already call these
  without an `env` argument, so removing the parameter is source-compatible with every real
  caller — confirmed by grep before starting this task (`grep -rln "env:" tests/adapters/git/
  baseline.test.ts tests/adapters/git/snapshots.test.ts src/cli/main.ts` returns nothing).

- [ ] **Step 1: Re-confirm no caller passes `env`**

  Run: `grep -rn "env:" src/cli/main.ts tests/adapters/git/baseline.test.ts tests/adapters/git/snapshots.test.ts tests/adapters/git/delta.test.ts`
  Expected: no matches. If this now finds something (code drifted since this plan was written),
  stop — this task is no longer safe as written.

- [ ] **Step 2: Strip the parameter from `commands.ts`, `baseline.ts`, `snapshots.ts`**

  In each of the three files, remove every `env?: Record<string, string>` parameter and every
  argument that forwards it (`env` passed positionally into `git(...)`/`gitOrThrow(...)`, and
  the `env` field on `GitBaselineOptions`/`GitSnapshotOptions`). This is a mechanical
  find-and-remove — there is no behavior change for any real caller, since none passes a value
  today.

- [ ] **Step 3: Run the full suite**

  Run: `bun run typecheck && bun test && bun run lint`
  Expected: all clean.

- [ ] **Step 4: Commit**

  ```bash
  git add src/adapters/git/commands.ts src/adapters/git/baseline.ts src/adapters/git/snapshots.ts
  git commit -m "Drop the now-unused env override parameter from the remaining git adapters"
  ```

---

### Task 5: Update `CLAUDE.md` to reflect Stage 4 as complete

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Replace the "Change detection" section**

  Replace the `### Change detection: watcher (default) now, git kept as a rollback` section
  (added when this plan was written, describing Stage 4 as not-yet-started) with:
  ```markdown
  ### Change detection: watcher only — git's RootRegistry retired in Stage 4

  The live app has exactly one change-detection mechanism: `adapters/watcher/*`. `core/
  config.ts`'s `detection` config flag is gone, and `cli/app.ts`'s composition root
  unconditionally builds `createWatcherRootRegistry`. `adapters/git/rootRegistry.ts` and
  `rootDiscovery.ts` — the git-backed `RootRegistry` and its real-`.git`-ancestor walk — are
  deleted, along with their tests.

  `adapters/git/{baseline,commands,delta,snapshots}.ts` are **not** deleted: `cli/main.ts`'s
  standalone `status`/`prune`/`reset` commands import them directly, independently of the live
  app's `RootRegistry`, and stay git-only — an already-settled design decision, not affected by
  this. Their own unit tests (`tests/adapters/git/{baseline,delta,snapshots}.test.ts`) are
  unchanged; `tests/app/gate.test.ts` (the full-pipeline suite) now exercises the real watcher
  adapter instead of a real git one, dropping the two test scenarios (a self-commit racing the
  baseline via git's own `HEAD`; a nested `.git` hiding a path behind a gitlink boundary) whose
  defect cannot occur once there is no git plumbing left in the live pipeline to produce it.
  ```

- [ ] **Step 2: Update the two adapter bullets under "The pieces"**

  In the `src/adapters/git/*` bullet, remove the "No longer the default... not on any deletion
  timeline yet (see 'Change detection' below)" sentence and replace it with a note that the
  `RootRegistry`/root-discovery half of this family is gone — only `baseline.ts`/`commands.ts`/
  `delta.ts`/`snapshots.ts` remain, used directly by `cli/main.ts`'s standalone commands.

  In the `src/adapters/watcher/*` bullet, remove the sentence describing it as merely "the
  default... as of `detection: 'watcher'`" and state plainly that it is the only
  `SnapshotStore`/`Baseline`/`RootRegistry` family the live app has.

- [ ] **Step 3: Commit**

  ```bash
  git add CLAUDE.md
  git commit -m "Document Stage 4: the git RootRegistry is retired"
  ```

## Verification (end to end, after Task 5)

1. `bun run typecheck && bun test && bun run lint` clean.
2. `tests/architecture.test.ts` passes — confirms no layering violation from the deletions.
3. `grep -rn "adapters/git/rootRegistry\.ts\|adapters/git/rootDiscovery\.ts" src tests CLAUDE.md`
   returns nothing.
4. Live smoke test via `bun src/cli/main.ts` (no `detection` config needed any more — there is
   only one behavior): open against a real git repo and confirm the board behaves as it did
   under `detection: "watcher"` before this plan (this was already the default; nothing about
   the live app's runtime behavior should change). Separately, run
   `bun src/cli/main.ts status` against this repo to confirm the git-only standalone commands
   still work — they never touched the deleted files.
5. `git log --oneline -6` shows five new commits (or four, if Task 4 was skipped), each leaving
   the suite green on its own.
