# Read-Only File Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code Explorer–style file tree to ISR's web UI (shared by the browser tab
and the Tauri desktop shell): browse every file in the project, independent of the review
board, and open one read-only.

**Architecture:** A new `ProjectTree` port (`list`/`read`) backed by `globby` (gitignore-aware
directory walk, not a git subprocess) is fetched once as a flat path list and reshaped into a
tree by a new pure `core/filetree.ts` function. Two new GET endpoints expose it; a new
`FileTree.tsx` panel (a fixed-position drawer, not a grid column) renders it and opens a file
in a read-only popup reusing the board's existing overlay styling. Along the way, the
pre-existing `Workspace` port is renamed to `EditTarget` (it was about to be confused with the
new port) and its traversal-guard logic is extracted into a small helper both ports share.

**Tech Stack:** TypeScript, Bun, React, `bun:test`, `globby` (new dependency), existing
ports-and-adapters architecture (see `CLAUDE.md`).

**Spec:** `docs/superpowers/specs/2026-09-02-file-explorer-design.md`

## Global Constraints

- `core` may not import `node:fs`, use `Bun.*`, or `fetch` (enforced by
  `tests/architecture.test.ts`) — `core/filetree.ts` must stay pure, no I/O.
- `adapters/web/ui/*` may only import from `core` or itself — `FileTree.tsx` imports
  `core/filetree.ts` and nothing else new.
- `app` may not name a concrete adapter — this plan makes no `app/` changes beyond renaming
  an existing port field (`workspace` → `editTarget`); no new coupling is introduced there.
- Read-only for v1: no write endpoint, no editable viewer (explicit non-goal in the spec).
- The whole file list is fetched once per panel-open (plus a refetch when `diffRevision`
  changes) — no lazy per-directory endpoint. Expand/collapse is pure client-side state.
- `globby`'s `dot: true` option is required in `createProjectTree` — without it, fast-glob's
  default matching silently excludes dotfiles and dot-directories, including `.gitignore`
  itself, which a real file browser must show.
- Every filesystem-touching adapter resolves paths through `adapters/fs/safePath.ts`'s
  `resolveInside`/`readInside` — there must be exactly one traversal-guard implementation,
  not two.
- No HTTP-level test harness exists anywhere in this codebase for `adapters/web/server.ts`
  today (confirmed: nothing under `tests/` calls `serveApp`). Task 5 does not invent one for
  two thin pass-through routes — see that task's own note.

---

### Task 1: Rename the `Workspace` port to `EditTarget`

**Files:**
- Modify: `src/core/ports.ts:304-314`
- Rename: `src/adapters/fs/workspace.ts` → `src/adapters/fs/editTarget.ts`
- Modify: `src/app/session.ts:14-30,67-95,532,828,851,862`
- Modify: `src/app/preflight.ts:1-13,104-114,135`
- Modify: `src/cli/app.ts:1-18,51,71`
- Modify: `src/adapters/acp/client.ts:139`
- Rename: `tests/adapters/fs-workspace.test.ts` → `tests/adapters/fs-editTarget.test.ts`
- Modify: `tests/app/session.test.ts` (import block + every `workspace`/`fakeWorkspace`
  identifier — 18 occurrences, enumerated in Step 6)
- Modify: `tests/app/preflight.test.ts` (import block + every `workspace`/`fakeWorkspace`
  identifier — 6 occurrences, enumerated in Step 7)
- Modify: `tests/app/streaming.test.ts:116`
- Modify: `tests/adapters/acp/client.test.ts:424`

**Interfaces:**
- Produces: `export interface EditTarget { read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void> }` in `core/ports.ts`, replacing
  `Workspace`. Same shape, new name — every later task in this plan imports `EditTarget`.
- Produces: `export function createFileEditTarget(cwd: string): EditTarget` in
  `src/adapters/fs/editTarget.ts`, replacing `createFileWorkspace`.

This is a pure rename with zero behavior change — no new test is written for it. The type
checker is the safety net: renaming the production symbols first turns every remaining
reference into a compile error, which is how Step 3 finds every file left to fix.

- [ ] **Step 1: Rename the port interface**

In `src/core/ports.ts`, change:

```ts
export interface Workspace {
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
}
```

to:

```ts
export interface EditTarget {
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
}
```

(The doc comment two lines above the interface — "The working tree, for the one thing ISR
writes to it..." — stays exactly as it is; it's still accurate.)

- [ ] **Step 2: Rename the adapter file and function**

```bash
git mv src/adapters/fs/workspace.ts src/adapters/fs/editTarget.ts
```

Replace the file's contents with:

```ts
import { isAbsolute, join } from 'node:path'
import type { EditTarget } from '../../core/ports.ts'

/**
 * Reading and writing files in the repository under review.
 *
 * Paths arrive from the browser, so they are resolved against the working directory and
 * checked to still be inside it. A review tool that can be talked into writing outside the
 * repository it is reviewing is a worse problem than any it solves.
 */
export function createFileEditTarget(cwd: string): EditTarget {
  const resolve = (path: string): string | null => {
    if (isAbsolute(path) || path.includes('\0')) return null

    const full = join(cwd, path)
    return full === cwd || full.startsWith(`${cwd}/`) ? full : null
  }

  return {
    read: async (path) => {
      const full = resolve(path)
      if (full === null) return null

      try {
        const file = Bun.file(full)
        return (await file.exists()) ? await file.text() : null
      } catch {
        return null
      }
    },

    write: async (path, text) => {
      const full = resolve(path)
      if (full === null) throw new Error(`refusing to write outside the repository: ${path}`)

      await Bun.write(full, text)
    },
  }
}
```

(Task 2 refactors this to use a shared helper — kept as a pure rename here so this diff is
easy to review on its own.)

- [ ] **Step 3: Run typecheck to find every remaining reference**

Run: `bun run typecheck`
Expected: FAIL, listing errors in `src/app/session.ts`, `src/app/preflight.ts`, and
`src/cli/app.ts` (each still references the now-gone `Workspace` name or the
now-gone `../adapters/fs/workspace.ts` path). Test files under `tests/` are checked by
`bun test`'s own type-stripping, not this command, so they won't show up here yet — Steps 6-8
handle them.

- [ ] **Step 4: Fix `src/app/session.ts`**

Change the type-only import (alphabetical order: `EditTarget` sorts between `Baseline` and
`PassLog`):

```ts
import type {
  AgentConnection,
  AgentConnectionFactory,
  AnalysisCache,
  AnnotationStore,
  Baseline,
  PassLog,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  RiskAdvisor,
  Session,
  SessionStore,
  SnapshotStore,
  Synthesizer,
  Workspace,
} from '../core/ports.ts'
```

to:

```ts
import type {
  AgentConnection,
  AgentConnectionFactory,
  AnalysisCache,
  AnnotationStore,
  Baseline,
  EditTarget,
  PassLog,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  RiskAdvisor,
  Session,
  SessionStore,
  SnapshotStore,
  Synthesizer,
} from '../core/ports.ts'
```

Change the `SessionDeps` field (line 75):

```ts
  workspace: Workspace
```
to
```ts
  editTarget: EditTarget
```

Change the destructure (line 95):

```ts
  const { snapshots, sessions, ledger, annotations, workspace, cache, synthesizer, config } = deps
```
to
```ts
  const { snapshots, sessions, ledger, annotations, editTarget, cache, synthesizer, config } = deps
```

Change the three call sites (lines 532, 828, 851, 862 — `workspace` appears once as an
object-literal shorthand property and three times as a method receiver):

```ts
        workspace,
```
to
```ts
        editTarget,
```

```ts
      const text = await workspace.read(chunk.path)
```
(appears twice, at the two `regionOf`/`applyEdit` sites) to
```ts
      const text = await editTarget.read(chunk.path)
```

```ts
      await workspace.write(chunk.path, result.text)
```
to
```ts
      await editTarget.write(chunk.path, result.text)
```

- [ ] **Step 5: Fix `src/app/preflight.ts`**

Change the type-only import:

```ts
import type {
  Baseline,
  ReviewLedger,
  ReviewUi,
  RiskAdvisor,
  SnapshotStore,
  Synthesizer,
  Workspace,
} from '../core/ports.ts'
```
to
```ts
import type {
  Baseline,
  EditTarget,
  ReviewLedger,
  ReviewUi,
  RiskAdvisor,
  SnapshotStore,
  Synthesizer,
} from '../core/ports.ts'
```

Change the `PreflightDeps` field:

```ts
export type PreflightDeps = {
  workspace: Workspace
```
to
```ts
export type PreflightDeps = {
  editTarget: EditTarget
```

Change the one call site:

```ts
  const current = await deps.workspace.read(input.path)
```
to
```ts
  const current = await deps.editTarget.read(input.path)
```

- [ ] **Step 6: Fix `src/cli/app.ts`**

Change the import block (alphabetical by file path — `fs/editTarget` sorts between
`fs/config` and `fs/ledger`):

```ts
import { createAcpClient } from '../adapters/acp/client.ts'
import { createFileAnnotationStore } from '../adapters/fs/annotations.ts'
import { createFileAnalysisCache } from '../adapters/fs/cache.ts'
import { loadConfig } from '../adapters/fs/config.ts'
import { createFileReviewLedger } from '../adapters/fs/ledger.ts'
import { createFilePassLog } from '../adapters/fs/passlog.ts'
import { createFileSessionStore } from '../adapters/fs/sessions.ts'
import { createFileWorkspace } from '../adapters/fs/workspace.ts'
import { createGitBaseline } from '../adapters/git/baseline.ts'
```
to
```ts
import { createAcpClient } from '../adapters/acp/client.ts'
import { createFileAnnotationStore } from '../adapters/fs/annotations.ts'
import { createFileAnalysisCache } from '../adapters/fs/cache.ts'
import { loadConfig } from '../adapters/fs/config.ts'
import { createFileEditTarget } from '../adapters/fs/editTarget.ts'
import { createFileReviewLedger } from '../adapters/fs/ledger.ts'
import { createFilePassLog } from '../adapters/fs/passlog.ts'
import { createFileSessionStore } from '../adapters/fs/sessions.ts'
import { createGitBaseline } from '../adapters/git/baseline.ts'
```

Change the construction line:

```ts
  const workspace = createFileWorkspace(cwd)
```
to
```ts
  const editTarget = createFileEditTarget(cwd)
```

Change the `createSession` call site:

```ts
    workspace,
```
to
```ts
    editTarget,
```

- [ ] **Step 7: Fix the one production comment referencing "workspace"**

In `src/adapters/acp/client.ts:139`, change:

```
 * absolute. Everything downstream assumes repo-relative — the workspace refuses an absolute
```
to
```
 * absolute. Everything downstream assumes repo-relative — the edit target refuses an absolute
```

- [ ] **Step 8: Run typecheck again — production code only**

Run: `bun run typecheck`
Expected: PASS. If it still fails, the error output names the remaining file — every
production touch point is listed above, so a failure here means one of Steps 4-7 was applied
incompletely, not that something new needs fixing.

- [ ] **Step 9: Rename and fix `tests/adapters/fs-workspace.test.ts`**

```bash
git mv tests/adapters/fs-workspace.test.ts tests/adapters/fs-editTarget.test.ts
```

Replace its contents with:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileEditTarget } from '../../src/adapters/fs/editTarget.ts'

/**
 * The one place ISR writes to the tree it is reviewing.
 *
 * Paths arrive from the browser, so the containment check is the whole point of this
 * adapter. A review tool that can be talked into writing outside the repository it reviews
 * is a worse problem than any it solves.
 */

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'isr-edit-target-'))
  await Bun.write(join(repo, 'src/a.ts'), 'export const value = 1\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('reading and writing inside the repository', () => {
  test('round-trips a file', async () => {
    const editTarget = createFileEditTarget(repo)
    await editTarget.write('src/a.ts', 'export const value = 2\n')

    expect(await editTarget.read('src/a.ts')).toBe('export const value = 2\n')
  })

  test('creates a file that was not there', async () => {
    const editTarget = createFileEditTarget(repo)
    await editTarget.write('src/new.ts', 'fresh\n')

    expect(await editTarget.read('src/new.ts')).toBe('fresh\n')
  })

  test('a missing file reads as null rather than throwing', async () => {
    expect(await createFileEditTarget(repo).read('src/nope.ts')).toBeNull()
  })

  test('a path that walks out and back in is fine', async () => {
    expect(await createFileEditTarget(repo).read('src/../src/a.ts')).toBe(
      'export const value = 1\n',
    )
  })
})

describe('refusing to leave the repository', () => {
  const outside = ['../escape.ts', '../../escape.ts', 'src/../../escape.ts']

  for (const path of outside) {
    test(`will not write to ${path}`, async () => {
      const editTarget = createFileEditTarget(repo)
      expect(editTarget.write(path, 'nope')).rejects.toThrow(/outside the repository/)
    })

    test(`and will not read ${path}`, async () => {
      expect(await createFileEditTarget(repo).read(path)).toBeNull()
    })
  }

  test('will not write to an absolute path', async () => {
    const editTarget = createFileEditTarget(repo)
    expect(editTarget.write('/tmp/escape.ts', 'nope')).rejects.toThrow(/outside the repository/)
  })

  /** A null byte truncates a path in some syscalls, so it never reaches one. */
  test('will not touch a path containing a null byte', async () => {
    const editTarget = createFileEditTarget(repo)
    expect(await editTarget.read('src/a.ts\0.png')).toBeNull()
    expect(editTarget.write('src/a.ts\0.png', 'nope')).rejects.toThrow(/outside the repository/)
  })

  /**
   * A sibling whose name merely starts with the repository's own — `/tmp/repo-evil` against
   * `/tmp/repo`. The check compares against the directory plus a separator for this reason.
   */
  test('will not be fooled by a sibling with a similar name', async () => {
    const sibling = `${repo}-evil`
    const editTarget = createFileEditTarget(repo)

    expect(editTarget.write(`../${sibling.split('/').pop()}/x.ts`, 'nope')).rejects.toThrow(
      /outside the repository/,
    )
  })
})
```

(This is Step 9's version — Task 2 trims the "refusing to leave" cases out of this file once
they're covered by a dedicated guard test, so don't be surprised when this file gets smaller
again shortly.)

- [ ] **Step 10: Fix `tests/app/session.test.ts`**

Change the type-only import (same alphabetical placement as Step 4):

```ts
import type {
  AgentConnection,
  AnnotationStore,
  Baseline,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  SnapshotStore,
  Workspace,
} from '../../src/core/ports.ts'
```
to
```ts
import type {
  AgentConnection,
  AnnotationStore,
  Baseline,
  EditTarget,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  SnapshotStore,
} from '../../src/core/ports.ts'
```

Every other occurrence in this file is the bare identifier `workspace`, `Workspace`, or
`fakeWorkspace` — never a substring of a longer identifier (verified: `grep -n
"workspace\|Workspace" tests/app/session.test.ts` before this step returns exactly 18 lines:
78, 80, 82, 83, 200, 221, 257, 288, 605, 639, 676, 691, 732, 823, 1070, 1319, 1491, 1754, 1765,
1812, 1823, 2191 — the `fakeWorkspace` function definition/uses plus every `workspace:`/
`workspace,`/`workspace.` deps-and-harness reference). Run:

```bash
sed -i '' \
  -e 's/fakeWorkspace/fakeEditTarget/g' \
  -e 's/\bWorkspace\b/EditTarget/g' \
  -e 's/\bworkspace\b/editTarget/g' \
  tests/app/session.test.ts
```

Then open the file and read the one comment sed will have touched (originally near line 676:
"...everything else it calls (workspace reads, ledger writes, and..."), now reading
"(editTarget reads, ledger writes, and..." — reword it by hand to "(reads through the edit
target, ledger writes, and..." so the sentence still reads naturally.

- [ ] **Step 11: Fix `tests/app/preflight.test.ts`**

Change the type-only import:

```ts
import type {
  Baseline,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  RiskAdvisor,
  SnapshotStore,
  Workspace,
} from '../../src/core/ports.ts'
```
to
```ts
import type {
  Baseline,
  EditTarget,
  ReviewLedger,
  ReviewRequest,
  ReviewUi,
  RiskAdvisor,
  SnapshotStore,
} from '../../src/core/ports.ts'
```

Every other occurrence is the bare identifier `workspace`, `Workspace`, or `fakeWorkspace`
(verified: 6 lines — 110, 160, 221, 275, 334, 397). Run:

```bash
sed -i '' \
  -e 's/fakeWorkspace/fakeEditTarget/g' \
  -e 's/\bWorkspace\b/EditTarget/g' \
  -e 's/\bworkspace\b/editTarget/g' \
  tests/app/preflight.test.ts
```

- [ ] **Step 12: Fix `tests/app/streaming.test.ts:116`**

```ts
    workspace: { read: async () => null, write: async () => {} },
```
to
```ts
    editTarget: { read: async () => null, write: async () => {} },
```

- [ ] **Step 13: Fix the one test comment referencing "workspace"**

In `tests/adapters/acp/client.test.ts:424`, change:

```
   * assumes repo-relative: the workspace refuses absolute paths outright (traversal guard),
```
to
```
   * assumes repo-relative: the edit target refuses absolute paths outright (traversal guard),
```

- [ ] **Step 14: Confirm nothing was missed**

Run: `grep -rn "workspace\|Workspace" src/ tests/ --include='*.ts' --include='*.tsx'`
Expected: no output at all. Any line still shown means a step above was skipped.

- [ ] **Step 15: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS, with the same test count as before this task (pure rename — nothing added or
removed).

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Rename the Workspace port to EditTarget

A second filesystem-touching port is coming next (for browsing the whole
project, not just the region a typed edit targets) and "Workspace" would
have been impossible to tell apart from it by name. Pure rename, no
behavior change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```

---

### Task 2: Extract the shared path-safety helper

**Files:**
- Create: `src/adapters/fs/safePath.ts`
- Modify: `src/adapters/fs/editTarget.ts`
- Create: `tests/adapters/fs-safePath.test.ts`
- Modify: `tests/adapters/fs-editTarget.test.ts` (trim the now-duplicated traversal matrix)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function resolveInside(root: string, path: string): string | null` and
  `export function readInside(root: string, path: string): Promise<string | null>` in
  `src/adapters/fs/safePath.ts`. Task 4's `createProjectTree` imports `readInside`.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/fs-safePath.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInside, resolveInside } from '../../src/adapters/fs/safePath.ts'

/**
 * The one guard every filesystem-touching adapter shares: never resolve a browser-supplied
 * path to somewhere outside the project root.
 */

describe('resolveInside', () => {
  test('joins a relative path onto the root', () => {
    expect(resolveInside('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
  })

  test('a path that walks out and back in is fine', () => {
    expect(resolveInside('/repo', 'src/../src/a.ts')).toBe('/repo/src/a.ts')
  })

  test('the root itself resolves', () => {
    expect(resolveInside('/repo', '.')).toBe('/repo')
  })

  for (const path of ['../escape.ts', '../../escape.ts', 'src/../../escape.ts']) {
    test(`refuses ${path}`, () => {
      expect(resolveInside('/repo', path)).toBeNull()
    })
  }

  test('refuses an absolute path', () => {
    expect(resolveInside('/repo', '/etc/passwd')).toBeNull()
  })

  test('refuses a path containing a null byte', () => {
    expect(resolveInside('/repo', 'src/a.ts\0.png')).toBeNull()
  })

  /** `/repo-evil` merely starts with `/repo` — the check must require the separator too. */
  test('is not fooled by a sibling with a similar name', () => {
    expect(resolveInside('/repo', '../repo-evil/x.ts')).toBeNull()
  })
})

describe('readInside', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'isr-safepath-'))
    await Bun.write(join(repo, 'src/a.ts'), 'export const value = 1\n')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  test('reads a real file', async () => {
    expect(await readInside(repo, 'src/a.ts')).toBe('export const value = 1\n')
  })

  test('a missing file reads as null', async () => {
    expect(await readInside(repo, 'src/nope.ts')).toBeNull()
  })

  test('a traversal attempt reads as null', async () => {
    expect(await readInside(repo, '../../etc/passwd')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/adapters/fs-safePath.test.ts`
Expected: FAIL — `src/adapters/fs/safePath.ts` does not exist yet.

- [ ] **Step 3: Implement the helper**

Create `src/adapters/fs/safePath.ts`:

```ts
import { isAbsolute, join } from 'node:path'

/**
 * Resolves `path` against `root`, refusing anything that would land outside it.
 *
 * Shared by every adapter that turns a browser-supplied path into a real one on disk — a
 * review tool that can be talked into touching a file outside the repository it is
 * reviewing is a worse problem than any it solves.
 */
export function resolveInside(root: string, path: string): string | null {
  if (isAbsolute(path) || path.includes('\0')) return null

  const full = join(root, path)
  return full === root || full.startsWith(`${root}/`) ? full : null
}

/**
 * Reads `path` (resolved safely against `root`) as UTF-8 text.
 *
 * Null covers three different situations alike on purpose — missing, unreadable, or outside
 * `root` — because none of them is something a caller can do anything about beyond showing
 * "not found".
 */
export async function readInside(root: string, path: string): Promise<string | null> {
  const full = resolveInside(root, path)
  if (full === null) return null

  try {
    const file = Bun.file(full)
    return (await file.exists()) ? await file.text() : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/adapters/fs-safePath.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Refactor `editTarget.ts` to use the shared helper**

Replace the contents of `src/adapters/fs/editTarget.ts` with:

```ts
import type { EditTarget } from '../../core/ports.ts'
import { readInside, resolveInside } from './safePath.ts'

/**
 * Reading and writing files in the repository under review.
 *
 * Paths arrive from the browser, so they are resolved against the working directory and
 * checked to still be inside it — see `safePath.ts` for the guard both this and
 * `projectTree.ts` share.
 */
export function createFileEditTarget(cwd: string): EditTarget {
  return {
    read: (path) => readInside(cwd, path),

    write: async (path, text) => {
      const full = resolveInside(cwd, path)
      if (full === null) throw new Error(`refusing to write outside the repository: ${path}`)

      await Bun.write(full, text)
    },
  }
}
```

- [ ] **Step 6: Run the existing edit-target tests to confirm the refactor is behavior-preserving**

Run: `bun test tests/adapters/fs-editTarget.test.ts`
Expected: PASS, unchanged — this refactor changes nothing observable.

- [ ] **Step 7: Trim the now-duplicated traversal matrix out of `fs-editTarget.test.ts`**

The exhaustive "refusing to leave the repository" cases now live in `fs-safePath.test.ts`
against the guard directly. Replace the contents of `tests/adapters/fs-editTarget.test.ts`
with:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileEditTarget } from '../../src/adapters/fs/editTarget.ts'

/**
 * The one place ISR writes to the tree it is reviewing.
 *
 * Traversal-guard coverage lives in `fs-safePath.test.ts` now that the guard is shared with
 * `projectTree.ts` — this file only checks that this adapter is wired to it correctly.
 */

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'isr-edit-target-'))
  await Bun.write(join(repo, 'src/a.ts'), 'export const value = 1\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

test('round-trips a file', async () => {
  const editTarget = createFileEditTarget(repo)
  await editTarget.write('src/a.ts', 'export const value = 2\n')

  expect(await editTarget.read('src/a.ts')).toBe('export const value = 2\n')
})

test('creates a file that was not there', async () => {
  const editTarget = createFileEditTarget(repo)
  await editTarget.write('src/new.ts', 'fresh\n')

  expect(await editTarget.read('src/new.ts')).toBe('fresh\n')
})

test('a missing file reads as null rather than throwing', async () => {
  expect(await createFileEditTarget(repo).read('src/nope.ts')).toBeNull()
})

test('refuses to write outside the repository', async () => {
  const editTarget = createFileEditTarget(repo)
  expect(editTarget.write('../escape.ts', 'nope')).rejects.toThrow(/outside the repository/)
})
```

- [ ] **Step 8: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/fs/safePath.ts src/adapters/fs/editTarget.ts \
  tests/adapters/fs-safePath.test.ts tests/adapters/fs-editTarget.test.ts
git commit -m "$(cat <<'EOF'
Extract the traversal-guard into a shared safePath helper

EditTarget's resolve() is about to get a sibling in ProjectTree that needs
the identical guard. Pulling it into adapters/fs/safePath.ts now means
there is exactly one implementation of "never leave the project root" for
both to share, rather than two copies to keep in sync.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```

---

### Task 3: `buildFileTree` — the pure tree-shaping function

**Files:**
- Create: `src/core/filetree.ts`
- Test: `tests/core/filetree.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type FileTreeNode = { kind: 'file'; name: string; path: string } | {
  kind: 'dir'; name: string; path: string; children: FileTreeNode[] }` and `export function
  buildFileTree(paths: string[]): FileTreeNode[]` in `src/core/filetree.ts`. Task 6's
  `FileTree.tsx` is the consumer.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/filetree.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { buildFileTree } from '../../src/core/filetree.ts'

/**
 * Turning a flat path list into what a file browser renders — grouping by directory and
 * sorting, since `ProjectTree.list()` promises neither.
 */

describe('building a tree from a flat path list', () => {
  test('an empty list produces an empty tree', () => {
    expect(buildFileTree([])).toEqual([])
  })

  test('a single top-level file', () => {
    expect(buildFileTree(['a.ts'])).toEqual([{ kind: 'file', name: 'a.ts', path: 'a.ts' }])
  })

  test('nests a file under its directory', () => {
    expect(buildFileTree(['src/a.ts'])).toEqual([
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [{ kind: 'file', name: 'a.ts', path: 'src/a.ts' }],
      },
    ])
  })

  test('two files in the same directory share one directory node', () => {
    const tree = buildFileTree(['src/a.ts', 'src/b.ts'])
    expect(tree).toEqual([
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [
          { kind: 'file', name: 'a.ts', path: 'src/a.ts' },
          { kind: 'file', name: 'b.ts', path: 'src/b.ts' },
        ],
      },
    ])
  })

  test('directories sort before files, both alphabetically', () => {
    const tree = buildFileTree(['z.ts', 'src/a.ts', 'a.ts'])
    expect(tree.map((node) => node.name)).toEqual(['src', 'a.ts', 'z.ts'])
  })

  test('deep nesting resolves every ancestor to the same directory node', () => {
    const tree = buildFileTree(['a/b/c/one.ts', 'a/b/c/two.ts', 'a/b/other.ts'])
    expect(tree).toEqual([
      {
        kind: 'dir',
        name: 'a',
        path: 'a',
        children: [
          {
            kind: 'dir',
            name: 'b',
            path: 'a/b',
            children: [
              {
                kind: 'dir',
                name: 'c',
                path: 'a/b/c',
                children: [
                  { kind: 'file', name: 'one.ts', path: 'a/b/c/one.ts' },
                  { kind: 'file', name: 'two.ts', path: 'a/b/c/two.ts' },
                ],
              },
              { kind: 'file', name: 'other.ts', path: 'a/b/other.ts' },
            ],
          },
        ],
      },
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/core/filetree.test.ts`
Expected: FAIL — `src/core/filetree.ts` does not exist yet.

- [ ] **Step 3: Implement `buildFileTree`**

Create `src/core/filetree.ts`:

```ts
/**
 * A flat list of repo-relative file paths, reshaped into the tree a file browser renders.
 *
 * Lives in `core` rather than the UI because it is pure — no I/O, no DOM — and testable the
 * same way the rest of the domain logic is. `adapters/web/ui` is the only consumer today.
 */

export type FileTreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'dir'; name: string; path: string; children: FileTreeNode[] }

/**
 * Builds a nested tree from a flat list of paths (as `ProjectTree.list()` returns), in one
 * call — no lazy per-directory fetching. The whole tree is available immediately, so
 * expand/collapse in the UI is instant client-side state.
 *
 * Directories sort before files; both alphabetically within their own group, at every level.
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const dirs = new Map<string, Extract<FileTreeNode, { kind: 'dir' }>>()

  for (const path of paths) {
    const segments = path.split('/')
    let siblings = root
    let prefix = ''

    segments.forEach((name, index) => {
      prefix = prefix === '' ? name : `${prefix}/${name}`
      const isLast = index === segments.length - 1

      if (isLast) {
        siblings.push({ kind: 'file', name, path: prefix })
        return
      }

      let dir = dirs.get(prefix)
      if (dir === undefined) {
        dir = { kind: 'dir', name, path: prefix, children: [] }
        dirs.set(prefix, dir)
        siblings.push(dir)
      }
      siblings = dir.children
    })
  }

  const sorted = (nodes: FileTreeNode[]): FileTreeNode[] =>
    [...nodes]
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      )
      .map((node) => (node.kind === 'dir' ? { ...node, children: sorted(node.children) } : node))

  return sorted(root)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/core/filetree.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/filetree.ts tests/core/filetree.test.ts
git commit -m "$(cat <<'EOF'
Add buildFileTree: flat path list to nested tree

Pure, testable in isolation, and living in core is what lets the UI
consume it without any adapter-layer coupling. No caller yet — the file
explorer UI wires it up in a later commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```

---

### Task 4: `ProjectTree` port and adapter

**Files:**
- Modify: `src/core/ports.ts` (add `ProjectTree`, after the `EditTarget` interface)
- Create: `src/adapters/fs/projectTree.ts`
- Modify: `package.json` (add `globby` dependency)
- Test: `tests/adapters/fs-projectTree.test.ts`

**Interfaces:**
- Consumes: `readInside` from `src/adapters/fs/safePath.ts` (Task 2).
- Produces: `export interface ProjectTree { list(): Promise<string[]>; read(path: string):
  Promise<string | null> }` in `core/ports.ts`, and `export function
  createProjectTree(cwd: string): ProjectTree` in `src/adapters/fs/projectTree.ts`. Task 5's
  `cli/app.ts` wiring and `server.ts` routes consume both.

- [ ] **Step 1: Add the `globby` dependency**

Run: `bun add globby`
Expected: `package.json`'s `dependencies` gains a `"globby"` line and `bun.lock` updates.

- [ ] **Step 2: Add the port**

In `src/core/ports.ts`, immediately after the `EditTarget` interface (added in Task 1), add:

```ts
/**
 * Every file in the project, for browsing rather than reviewing.
 *
 * Deliberately independent of `EditTarget`: this is a read-only tree of the whole project,
 * not the narrow read/write surface a typed edit uses — the two ports should never be
 * confused for one another the way `Workspace` and this once nearly were.
 */
export interface ProjectTree {
  /** Every non-ignored file path in the project, relative to the repo root, forward-slash
   *  separated. Directories are implied by path segments, not listed separately. */
  list(): Promise<string[]>
  /** A file's current contents, or null if it doesn't exist, can't be read, or resolves
   *  outside the project root. */
  read(path: string): Promise<string | null>
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/adapters/fs-projectTree.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectTree } from '../../src/adapters/fs/projectTree.ts'

/**
 * The browsable project tree: every file, minus whatever `.gitignore` — at any level — says
 * to skip, and always minus `.git` itself.
 */

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'isr-project-tree-'))

  await Bun.write(join(repo, '.gitignore'), 'node_modules\n')
  await Bun.write(join(repo, 'src/a.ts'), 'export const a = 1\n')
  await Bun.write(join(repo, 'src/b.ts'), 'export const b = 2\n')
  await Bun.write(join(repo, 'nested/.gitignore'), 'ignored.txt\n')
  await Bun.write(join(repo, 'nested/keep.ts'), 'export const keep = true\n')
  await Bun.write(join(repo, 'nested/ignored.txt'), 'should not appear\n')
  await Bun.write(join(repo, 'node_modules/pkg/index.js'), 'module.exports = {}\n')
  await mkdir(join(repo, '.git'), { recursive: true })
  await Bun.write(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('list', () => {
  test('includes ordinary files and dotfiles alike', async () => {
    const paths = await createProjectTree(repo).list()
    expect(paths).toContain('src/a.ts')
    expect(paths).toContain('src/b.ts')
    expect(paths).toContain('nested/keep.ts')
    expect(paths).toContain('.gitignore')
  })

  test('excludes a file matched by the root .gitignore', async () => {
    const paths = await createProjectTree(repo).list()
    expect(paths).not.toContain('node_modules/pkg/index.js')
  })

  test('excludes a file matched by a nested .gitignore', async () => {
    const paths = await createProjectTree(repo).list()
    expect(paths).not.toContain('nested/ignored.txt')
  })

  test('always excludes .git, gitignore or not', async () => {
    const paths = await createProjectTree(repo).list()
    expect(paths.some((path) => path.startsWith('.git/'))).toBe(false)
  })
})

describe('read', () => {
  test('reads a real file', async () => {
    expect(await createProjectTree(repo).read('src/a.ts')).toBe('export const a = 1\n')
  })

  test('a missing file reads as null', async () => {
    expect(await createProjectTree(repo).read('src/nope.ts')).toBeNull()
  })

  test('a traversal attempt reads as null', async () => {
    expect(await createProjectTree(repo).read('../../etc/passwd')).toBeNull()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/adapters/fs-projectTree.test.ts`
Expected: FAIL — `src/adapters/fs/projectTree.ts` does not exist yet.

- [ ] **Step 5: Implement the adapter**

Create `src/adapters/fs/projectTree.ts`:

```ts
import { globby } from 'globby'
import type { ProjectTree } from '../../core/ports.ts'
import { readInside } from './safePath.ts'

/**
 * Every file in the project, respecting `.gitignore` — including nested ones, which is what
 * `globby`'s `gitignore` option buys over hand-rolled ignore-pattern matching. `.git` is
 * excluded explicitly: it isn't itself expressed by any `.gitignore` rule.
 */
export function createProjectTree(cwd: string): ProjectTree {
  return {
    list: () =>
      globby(['**/*'], {
        cwd,
        gitignore: true,
        onlyFiles: true,
        // fast-glob's default matching excludes dotfiles/dot-directories — without this, a
        // real file browser would silently hide .gitignore, .env, .github/, etc.
        dot: true,
        ignore: ['.git'],
      }),

    read: (path) => readInside(cwd, path),
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/adapters/fs-projectTree.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/core/ports.ts src/adapters/fs/projectTree.ts \
  tests/adapters/fs-projectTree.test.ts
git commit -m "$(cat <<'EOF'
Add the ProjectTree port and its globby-backed adapter

list() walks the project with globby's gitignore option (nested
.gitignore files included) rather than shelling out to git — file
browsing shouldn't depend on git-repo internals for something that is
really just "walk a directory." read() reuses the safePath guard
EditTarget already shares.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```

---

### Task 5: Wire `ProjectTree` into the server and composition root

**Files:**
- Modify: `src/adapters/web/server.ts:1,17-22,26-27,201-203`
- Modify: `src/cli/app.ts` (import block, construction, `serveApp` call)

**Interfaces:**
- Consumes: `ProjectTree` (Task 4).
- Produces: `GET /files` (200, `string[]`) and `GET /files/content?path=...` (200 `{ text:
  string }` or 404 `{ error: string }`) — Task 6's `FileTree.tsx` is the consumer.

No new automated test in this task. Every existing test for `server.ts` behavior is
integration-style through `session`, and nothing under `tests/` calls `serveApp` directly
today (confirmed by `grep -rl serveApp tests/` returning nothing) — so there is no existing
harness pattern to extend for two endpoints that are themselves thin pass-throughs to
`ProjectTree`, which Task 4 already tests thoroughly. `bun run typecheck` catches a wiring
mistake (wrong types, a missing field); Task 6's manual browser check exercises the routes for
real over HTTP.

- [ ] **Step 1: Add `projectTree` to `ServerOptions` and destructure it**

In `src/adapters/web/server.ts`, change the top import:

```ts
import type { Session } from '../../core/ports.ts'
```
to
```ts
import type { ProjectTree, Session } from '../../core/ports.ts'
```

Change the options type:

```ts
export type ServerOptions = {
  session: Session
  port?: number
  /** Injectable so tests can bind an ephemeral port and still learn which one. */
  onListening?: (url: string) => void
}
```
to
```ts
export type ServerOptions = {
  session: Session
  projectTree: ProjectTree
  port?: number
  /** Injectable so tests can bind an ephemeral port and still learn which one. */
  onListening?: (url: string) => void
}
```

Change the destructure:

```ts
  const { session } = options
```
to
```ts
  const { session, projectTree } = options
```

- [ ] **Step 2: Add the two routes**

In the `routes` object, immediately after the existing `/activity` route:

```ts
      // Fetched on demand rather than pushed: it is only read when the activity view is
      // open, and most of a session's state changes have nothing to do with it.
      '/activity': async () => json(await session.activity()),

      '/edit': {
```

insert a new block between them, so it reads:

```ts
      // Fetched on demand rather than pushed: it is only read when the activity view is
      // open, and most of a session's state changes have nothing to do with it.
      '/activity': async () => json(await session.activity()),

      // The file explorer: every project file, independent of the review board — see
      // docs/superpowers/specs/2026-09-02-file-explorer-design.md.
      '/files': async () => json(await projectTree.list()),

      '/files/content': async (request: Request) => {
        const path = new URL(request.url).searchParams.get('path') ?? ''
        const text = path === '' ? null : await projectTree.read(path)
        return text === null ? json({ error: 'not found' }, 404) : json({ text })
      },

      '/edit': {
```

- [ ] **Step 3: Wire the composition root**

In `src/cli/app.ts`, change the import block (alphabetical by file path — `fs/projectTree`
sorts between `fs/passlog` and `fs/sessions`):

```ts
import { createAcpClient } from '../adapters/acp/client.ts'
import { createFileAnnotationStore } from '../adapters/fs/annotations.ts'
import { createFileAnalysisCache } from '../adapters/fs/cache.ts'
import { loadConfig } from '../adapters/fs/config.ts'
import { createFileEditTarget } from '../adapters/fs/editTarget.ts'
import { createFileReviewLedger } from '../adapters/fs/ledger.ts'
import { createFilePassLog } from '../adapters/fs/passlog.ts'
import { createFileSessionStore } from '../adapters/fs/sessions.ts'
import { createGitBaseline } from '../adapters/git/baseline.ts'
```
to
```ts
import { createAcpClient } from '../adapters/acp/client.ts'
import { createFileAnnotationStore } from '../adapters/fs/annotations.ts'
import { createFileAnalysisCache } from '../adapters/fs/cache.ts'
import { loadConfig } from '../adapters/fs/config.ts'
import { createFileEditTarget } from '../adapters/fs/editTarget.ts'
import { createFileReviewLedger } from '../adapters/fs/ledger.ts'
import { createFilePassLog } from '../adapters/fs/passlog.ts'
import { createProjectTree } from '../adapters/fs/projectTree.ts'
import { createFileSessionStore } from '../adapters/fs/sessions.ts'
import { createGitBaseline } from '../adapters/git/baseline.ts'
```

Change the construction block:

```ts
  const editTarget = createFileEditTarget(cwd)
  const baseline = createGitBaseline({ cwd, trunk: config.trunk })
```
to
```ts
  const editTarget = createFileEditTarget(cwd)
  const projectTree = createProjectTree(cwd)
  const baseline = createGitBaseline({ cwd, trunk: config.trunk })
```

Change the `serveApp` call:

```ts
  const server = serveApp({ session })
```
to
```ts
  const server = serveApp({ session, projectTree })
```

- [ ] **Step 4: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/server.ts src/cli/app.ts
git commit -m "$(cat <<'EOF'
Wire ProjectTree into the server: GET /files and /files/content

Two thin pass-through routes onto the already-tested ProjectTree adapter.
No new test harness added here — nothing in this codebase tests
server.ts routes over HTTP today, and Task 6's manual browser check
exercises these for real.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```

---

### Task 6: The `FileTree` panel and viewer

**Files:**
- Create: `src/adapters/web/ui/FileTree.tsx`
- Modify: `src/adapters/web/ui/App.tsx`
- Modify: `src/adapters/web/ui/styles.css`

**Interfaces:**
- Consumes: `buildFileTree`/`FileTreeNode` from `src/core/filetree.ts` (Task 3); `GET /files`
  and `GET /files/content?path=...` (Task 5).
- Produces: `export function FileTree({ open, diffRevision, onClose }: { open: boolean;
  diffRevision: number; onClose: () => void }): JSX.Element` — `App.tsx` is the only consumer.

No automated test: this repo has no component-test harness for `adapters/web/ui/*` (every
existing `.tsx` file is untested by `bun:test`; verification is by hand in the browser, per
this project's own convention for UI changes). Steps 5-6 are that manual check.

- [ ] **Step 1: Create `FileTree.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { buildFileTree, type FileTreeNode } from '../../../core/filetree.ts'

/**
 * A VS Code Explorer–style file tree: every project file, independent of the review board.
 *
 * One fetch gets the whole flat path list; the tree is built from it once and expand/collapse
 * is pure client state after that — no round-trip per folder click.
 */

type Viewing = { path: string; text: string } | null

export function FileTree({
  open,
  diffRevision,
  onClose,
}: {
  open: boolean
  /** The same "the tree moved" signal `App.tsx`'s own diff pane refetches on. */
  diffRevision: number
  onClose: () => void
}) {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [listError, setListError] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<Viewing>(null)
  const [viewError, setViewError] = useState<string | null>(null)

  // Fetched only while the panel is open, and refetched whenever the working tree moved — a
  // file the agent just created or deleted belongs in the list immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRevision is a refetch signal
  useEffect(() => {
    if (!open) return
    let live = true
    setListError(false)
    void fetch('/files')
      .then((response) => {
        if (!response.ok) throw new Error('failed to list files')
        return response.json() as Promise<string[]>
      })
      .then((next) => {
        if (live) setPaths(next)
      })
      .catch(() => {
        if (live) setListError(true)
      })
    return () => {
      live = false
    }
  }, [open, diffRevision])

  // Closes the viewer the same three ways ChunkView's own detail popup does.
  useEffect(() => {
    if (viewing === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setViewing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openFile = (path: string): void => {
    setViewError(null)
    setViewing({ path, text: '' })
    void fetch(`/files/content?path=${encodeURIComponent(path)}`)
      .then((response) => {
        if (!response.ok) throw new Error('not found')
        return response.json() as Promise<{ text: string }>
      })
      .then((body) => setViewing({ path, text: body.text }))
      .catch(() => setViewError('Could not read this file — it may no longer exist.'))
  }

  const tree = paths === null ? [] : buildFileTree(paths)

  return (
    <>
      <aside className={`file-tree ${open ? 'open' : ''}`}>
        <header>
          Files
          <button
            type="button"
            className="panel-close"
            title="Close the file tree"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="file-tree-body">
          {listError && <p className="placeholder">Couldn't list files.</p>}
          {!listError && paths === null && <p className="placeholder">Loading…</p>}
          {!listError && paths !== null && paths.length === 0 && (
            <p className="placeholder">Nothing here.</p>
          )}
          {tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              onOpenFile={openFile}
            />
          ))}
        </div>
      </aside>

      {viewing !== null && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally above
        // biome-ignore lint/a11y/noStaticElementInteractions: a backdrop's only role is dismissal
        <div className="scrim" onClick={() => setViewing(null)}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: not a control, just a bubble stop */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: not a control, just a bubble stop */}
          <section className="work" onClick={(event) => event.stopPropagation()}>
            <div className="chunk-view">
              <button
                type="button"
                className="chunk-close"
                title="Close this file"
                onClick={() => setViewing(null)}
              >
                ×
              </button>
              <header className="chunk-head">
                <h2>{viewing.path}</h2>
              </header>
              {viewError !== null ? (
                <p className="placeholder">{viewError}</p>
              ) : (
                <pre className="file-contents">{viewing.text}</pre>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenFile,
}: {
  node: FileTreeNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const indent = { paddingLeft: `${depth * 14 + 8}px` }

  if (node.kind === 'file') {
    return (
      <button
        type="button"
        className="tree-row tree-file"
        style={indent}
        onClick={() => onOpenFile(node.path)}
      >
        {node.name}
      </button>
    )
  }

  const isOpen = expanded.has(node.path)
  return (
    <>
      <button
        type="button"
        className="tree-row tree-dir"
        style={indent}
        onClick={() => onToggle(node.path)}
      >
        <span className="caret">{isOpen ? '▾' : '▸'}</span>
        {node.name}
      </button>
      {isOpen &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}
```

- [ ] **Step 2: Wire `FileTree` into `App.tsx`**

Change the sibling-component imports:

```ts
import { ChunkList } from './ChunkList.tsx'
import { ChunkView } from './ChunkView.tsx'
```
to
```ts
import { ChunkList } from './ChunkList.tsx'
import { ChunkView } from './ChunkView.tsx'
import { FileTree } from './FileTree.tsx'
```

Add panel-open state, right after the existing draft state:

```ts
  const state = useSession()
  const [draft, setDraft] = useState('')
```
to
```ts
  const state = useSession()
  const [draft, setDraft] = useState('')
  const [filesOpen, setFilesOpen] = useState(false)
```

Change the conversation header to hold a "Files" toggle alongside the existing Cancel button
(grouped so `justify-content: space-between` still has exactly two children — the status span
and this new wrapper):

```tsx
        <header>
          {/* The party, not the state name. `reviewing` was the same word for two opposite
              situations — the adversary reading, and the reader being asked — which is the
              distinction the whole app turns on. */}
          <span className={`status waiting-${waiting.on}`}>
            {waiting.busy && <span className="spinner spinner-inline" aria-hidden="true" />}
            {waiting.label}
          </span>
          {busy && (
            <button type="button" onClick={() => void post('/cancel', {})}>
              Cancel
            </button>
          )}
        </header>
```
to
```tsx
        <header>
          {/* The party, not the state name. `reviewing` was the same word for two opposite
              situations — the adversary reading, and the reader being asked — which is the
              distinction the whole app turns on. */}
          <span className={`status waiting-${waiting.on}`}>
            {waiting.busy && <span className="spinner spinner-inline" aria-hidden="true" />}
            {waiting.label}
          </span>
          <div className="header-actions">
            <button type="button" onClick={() => setFilesOpen(true)}>
              Files
            </button>
            {busy && (
              <button type="button" onClick={() => void post('/cancel', {})}>
                Cancel
              </button>
            )}
          </div>
        </header>
```

Render the panel as a sibling of the top-level app `<div>`'s other children, right before its
closing tag (after the existing `showDetail` scrim block, still inside the outermost
`return (...)`):

```tsx
      {showDetail && selected !== null && (
        // ... existing block, unchanged ...
      )}
    </div>
  )
}
```
to
```tsx
      {showDetail && selected !== null && (
        // ... existing block, unchanged ...
      )}

      <FileTree
        open={filesOpen}
        diffRevision={state.diffRevision}
        onClose={() => setFilesOpen(false)}
      />
    </div>
  )
}
```

- [ ] **Step 3: Add CSS**

Append to the end of `src/adapters/web/ui/styles.css`:

```css
/* ── The file explorer: a drawer, independent of the board — same "borrow the window when
   you need it, give it back when you don't" reasoning as .scrim/.work above ── */

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-close {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
}

.file-tree {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 280px;
  background: var(--panel);
  border-right: 1px solid var(--line);
  box-shadow: 8px 0 24px rgb(0 0 0 / 35%);
  transform: translateX(-100%);
  transition: transform 0.15s ease;
  display: flex;
  flex-direction: column;
  z-index: 15;
}

.file-tree.open {
  transform: translateX(0);
}

.file-tree > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 11px;
}

.file-tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-row {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-radius: 0;
  padding: 3px 8px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-row:hover {
  background: var(--line);
}

.tree-dir .caret {
  display: inline-block;
  width: 14px;
  color: var(--muted);
}

.file-contents {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  margin: 0;
}
```

- [ ] **Step 4: Full regression**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 5: Manual verification in the browser**

```bash
SCRATCH=$(mktemp -d) && cd "$SCRATCH" && git init -q \
  && git config user.email t@t.com && git config user.name t
mkdir -p src nested node_modules/pkg
echo 'export const a = 1' > src/a.ts
echo 'export const b = 2' > src/b.ts
echo 'node_modules' > .gitignore
echo 'ignored.txt' > nested/.gitignore
echo 'kept' > nested/keep.ts
echo 'not kept' > nested/ignored.txt
echo '{}' > node_modules/pkg/index.js
git add -A && git commit -q -m baseline
bun ~/projects/isr/src/cli/main.ts
```

In the browser tab that opens:
- Click "Files". The drawer slides in from the left.
- Confirm `node_modules/` and `nested/ignored.txt` do **not** appear; `.gitignore` (the
  dotfile itself) **does** appear; `src/`, `nested/` (with `keep.ts` inside once expanded)
  are present.
- Open the browser devtools Network tab. Expand `src/`, then `nested/` — confirm **no** new
  request fires (the whole tree came from the one `/files` call already made).
- Click `src/a.ts`. A popup opens showing `export const a = 1` — read-only (no textarea, no
  edit affordance anywhere in it).
- Press Escape — the popup closes. Reopen a file, click the backdrop outside the popup —
  it closes the same way.
- Click the drawer's own × — the drawer closes; the "Files" button in the header still
  reopens it.
- With the drawer still open, ask the agent (in the conversation column) to create a new
  file. Once its turn ends, confirm the new file now appears in the tree without needing to
  toggle the drawer closed and back open (the `diffRevision` refetch).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/ui/FileTree.tsx src/adapters/web/ui/App.tsx \
  src/adapters/web/ui/styles.css
git commit -m "$(cat <<'EOF'
Add the file explorer panel: browse and view any project file

A left-edge drawer (not a grid column, matching the same reasoning the
board's own detail popup already uses) listing every non-ignored project
file, independent of the review board. Clicking a file opens its current
contents read-only. Verified by hand in the browser: gitignore exclusion
(root and nested), dotfile inclusion, instant expand/collapse with no
per-folder request, and the tree picking up a file the agent just created.

Implements docs/superpowers/specs/2026-09-02-file-explorer-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M2oh9JPdnpK4mrXPQ3wrBo
EOF
)"
```
