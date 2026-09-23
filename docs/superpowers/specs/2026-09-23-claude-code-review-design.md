# Pivot: rule verdicts → one async Claude Code review per turn

## Context

The reviewer today is an OpenRouter tool loop (`adapters/model/reviewer.ts`) that judges each
changed file against YAML rules kept outside the checkout, returning a typed verdict per rule,
re-run after every edit. Coding agents already carry skills (and CLAUDE.md) that enforce most of
what those rules encode, so the rules are duplicated effort, and a file no rule governs is never
reviewed at all. The pivot: delete rules entirely and run **one standard, read-only Claude Code
review agent** (via the Agent SDK, so it loads the repo's skills/CLAUDE.md natively), **once per
turn and only if the turn changed files**, returning the same structured findings the board
already consumes. Findings persist per session and self-invalidate by content hash; files whose
review is stale or missing show "not reviewed" and can be reviewed on demand with **Review now**.

Decisions made with the user: Claude Code via Agent SDK (not OpenRouter); after each turn only
if edits were made; delete rules entirely; finding = `{path,startLine,endLine,severity,title,message}`;
persist findings per session; stale/unreviewed files → mark + manual "Review now" (no automatic
catch-up on resume).

## The one rule

A review run covers **every board file (not skipped by `skipReasons`) with no current review** —
no stored entry, or a stored `fileHash` ≠ the file's `contentHash` now. Both triggers call the
same run:
- **Turn end**, only when the board's `next` tree differs from the one captured at turn start
  (files the agent changed are stale by definition).
- **Review now** (manual), for drift between turns: resume, hand edits, a checkout, another session.

## Design

### 1. Port (`src/core/ports.ts`, `src/core/types.ts`)
- `Finding`: replace `rule` with `title`; `message` is now reviewer-written.
- `Reviewer { review(input: ReviewInput): Promise<Finding[]> }`,
  `ReviewInput = { root; files: {path, kind, previousPath?}[]; diff: string }` (diff capped).
  Findings may be in any file (a broken caller).
- New `FindingStore { load(sessionId): Promise<StoredReview[]>; save(sessionId, reviews) }`,
  `StoredReview = { root; path; fileHash; findings: Finding[]; reviewedAt }` — zero findings is
  still "reviewed". Reuse `changedSince` (`core/annotations.ts`) for staleness.
- Delete `RuleSource`, `LoadedRules`, `FileReviewInput`, `AnalysisCache`, `FileReview`.

### 2. Reviewer adapter (`src/adapters/agent-sdk/reviewer.ts`, new)
- One `query()` per run, string prompt, `persistSession: false`, default `settingSources`
  (loads CLAUDE.md + skills like the CLI), `cwd: root`, `env: {...process.env}`,
  `pathToClaudeCodeExecutable: resolveExecutable()`, injectable `queryFn` (same shape as
  `client.ts`), `abortController` for `timeoutMs`, `maxTurns`, optional `model`.
- Tools: Read/Grep/Glob/Skill + Bash gated by `core/toolSafety.ts` `isReadOnlyCall` in a small
  `canUseTool` (also `reservedPathIn` first). Disallow Edit/Write/NotebookEdit/Agent/WebFetch/
  WebSearch. Export `protectionOptions` from `agent-sdk/client.ts` and reuse (sandbox + deny rules
  for `~/.turnstile`, `<cwd>/.turnstile`).
- `submit_findings` via `tool()` + `createSdkMcpServer({name:'review'})` (pattern of
  `buildWriteTool`, return type unannotated so `.handler` is testable). Zod array of findings;
  handler validates (paths relative & inside root, `endLine >= startLine`, non-empty title) and
  returns errors as the tool result so the model corrects in-run; first accepted submission is
  captured. Run ends without acceptance → throw.
- `REVIEW_SYSTEM_PROMPT` moves here (rewritten): review only what the change introduced; grep
  callers of changed exports (tests included); use the repo's skills/CLAUDE.md conventions;
  empty is an expected answer; submit once. Keep the caller-check paragraph from `prompts.ts`.

### 3. Pipeline (`src/app/review.ts`, rewritten, much smaller)
`reviewStale(deps)`: `captureBoardFor` → `chunksOf` → `onChunks` (skips unchanged) → select
stale files (store + `contentHash` of `next` contents) → if none, return → `onReviewing` for all
their chunks → build unified diff for them (`board.ts`/snapshots) → `reviewer.review` → per file
`assignFindings` → `onReviewed`; save `StoredReview`s with the hashes captured **before** the
run (so a file edited mid-review stays stale). On error: `onFailed` for all. Telemetry span kept.

### 4. Session (`src/app/session.ts`)
- Remove `startReview()` from `afterPossibleEdit` (~:354) and `switchTo` (~:689); board refresh
  and `publishChunks` stay so the list still updates live (chunks show "not reviewed").
- Turn start: record board `next` tree; turn end (~:1305): if changed, `startReview()`.
- `reviewNow()` on `Session`; `startReview` stays `coalesce`d.
- On open/resume: load `FindingStore`, apply current entries via `onReviewed` path, drop stale.
- `SessionState` gains `unreviewed: number` (or derive in UI) for the button.
- Deps: drop `rules`, `cache`, `reader` from review; add `findings: FindingStore`.

### 5. Web (`src/adapters/web/server.ts`, `ui/`)
- `POST /review` → `session.reviewNow()`.
- "Review now" button in `ChangedFiles.tsx` rail header, shown when any file is unreviewed;
  disabled while a review is in flight.
- `editor/parts.tsx` `FindingList`: `finding.rule` → `finding.title` (`.finding-rule` →
  `.finding-title` in `styles.css`); `CodeDocument.tsx:151` findingsKey uses `title`.
- `scripts/simulate.ts` fixtures: `rule` → `title`; stub `reviewNow`.

### 6. Composition + config
- `src/cli/app.ts`: wire `createAgentSdkReviewer` + `createFileFindingStore`; delete rules source,
  warnings wrapper, `rulesDirFor` line, leftover-rules warning, rulesDir from `protectedDirs`.
- `src/core/config.ts`: `review = { model?: string (Claude alias), timeoutMs, maxTurns }`; delete
  top-level `model`, `review.concurrency/maxSteps/rulesDir`; update `DEFAULT_CONFIG`.
- `src/adapters/fs/findings.ts` (new): `.turnstile/findings.json`, keyed by session id; `turnstile
  reset` clears it (`src/cli/main.ts`).

### 7. Deletions
`src/core/rules.ts`, `src/core/verdicts.ts`, `src/adapters/fs/rules.ts`,
`src/adapters/model/reviewer.ts`, reviewer half of `src/adapters/model/prompts.ts`,
`src/adapters/fs/cache.ts`; tests `tests/support/rules.ts`, `tests/core/rules.test.ts`,
`tests/core/verdicts.test.ts`, `tests/adapters/fs-rules.test.ts`,
`tests/adapters/model/reviewer.test.ts`, `tests/adapters/fs-cache.test.ts`. Keep asker,
`openrouter`, `ask`, `RepoReader`, `createModel`.

### 8. Docs
Write this design to `docs/superpowers/specs/2026-09-23-claude-code-review-design.md` and commit
(first step after approval). Rewrite README review/rules/config/metrics sections and CLAUDE.md
(review.ts, reviewer, rules, testing-conventions, known-gaps) to match.

## Implementation order
1. Spec doc commit (on a feature branch).
2. Core types/ports (`Finding.title`, `Reviewer`, `FindingStore`); fix compile fallout in UI/simulate.
3. `FindingStore` fs adapter + tests.
4. Agent SDK reviewer adapter + tests (fake `queryFn`, direct `.handler` tests).
5. Rewrite `app/review.ts` + tests.
6. Session triggers, `reviewNow`, resume restore + tests (update `session.test.ts`,
   `streaming.test.ts` "board during a turn" suite which asserts mid-turn analysis).
7. Server route + UI button.
8. Composition root + config; delete rules/cache/OpenRouter reviewer and their tests.
9. README + CLAUDE.md.

## Verification
- `bun run typecheck && bun run lint && bun test` (incl. `tests/architecture.test.ts`).
- Session tests: turn with no edits → reviewer not called; turn with edits → called once with
  exactly the stale files; resume with a changed file → its findings dropped, marked unreviewed;
  `reviewNow` reviews only stale files; failure → `Review failed`.
- `bun run simulate`: Review now button renders, findings show titles.
- Live smoke (`bun src/cli/main.ts` in a scratch git repo with a project skill): confirm the
  reviewer loads the skill/CLAUDE.md, only uses read tools, submits via `submit_findings`,
  runs once per editing turn, and nothing appears in `claude` session history.
