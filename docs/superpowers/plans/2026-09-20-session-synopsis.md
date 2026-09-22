# Session Synopsis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** When you resume a session — or ask for it — get a short account of what happened in it:
what the agent did, what changed against the baseline, and what is still outstanding. Resuming a
conversation currently means scrolling a transcript to remember where you were.

**Architecture:** A new `Summarizer` port (one method, `summarize`) backed by the same OpenRouter
model the reviewer uses. The transcript-to-prompt reduction is a pure function in
`core/synopsis.ts`, so the only untestable part is the model call itself. The result lands on
`SessionState` as `synopsis`, pushed like every other state change, and renders at the top of the
conversation panel.

**Tech Stack:** TypeScript, Bun, React, `bun:test`, `ai` SDK's `generateText`, existing
ports-and-adapters architecture (see `CLAUDE.md`).

**Independent of:** the plan-panel and highlight-to-ask plans. Nothing here blocks or is blocked by
them.

## Global Constraints

- `core` may not import `node:fs`, use `Bun.*`, or `fetch` (enforced by
  `tests/architecture.test.ts`) — `core/synopsis.ts` must stay pure.
- `app` may not name a concrete adapter. `app/session.ts` depends on the `Summarizer` interface
  only; `cli/app.ts` supplies it.
- **The agent is not the summarizer.** Use the OpenRouter model (`config.model`, via
  `adapters/model/client.ts`'s `createModel`), not the Claude Agent SDK connection. Asking the
  agent to summarize spends its context window on describing work rather than doing it, and it
  cannot run while the agent is mid-turn.
- **A synopsis must never fail a session.** Same rule as the review: every failure path costs the
  synopsis and nothing else. No throw reaches `resumeSession`.
- A missing `OPENROUTER_API_KEY` is the ordinary case for someone who has not configured one.
  It produces no synopsis and no error banner.

## Known unknowns, to settle before building

- **Is it useful, or is it noise?** This is the real risk, not the plumbing. Task 1 exists to find
  out cheaply, before any port or adapter is written.
- **Transcript size.** A long session's transcript will not fit a prompt. Bounding it is Task 2 and
  is the part most likely to need iteration.

---

### Task 1: Find out whether a synopsis is worth having

Before writing any production code, establish that the output is worth reading.

- [ ] Run a real session (`bun src/cli/main.ts` against a scratch repo) long enough to have a
      transcript worth summarizing — several turns, a few file changes.
- [ ] Dump its `state().transcript` and the `git diff --stat` against the baseline to a scratch
      file.
- [ ] Hand that to the configured model by hand (a throwaway script, not committed) with two or
      three candidate prompts.
- [ ] Judge the output: does it tell you something scrolling the transcript would not? Record the
      prompt that worked in this file before continuing.
- [ ] **If none of them read well, stop here and say so.** Nothing below is worth building for a
      summary nobody would read.

### Task 2: `core/synopsis.ts` — reducing a session to a prompt payload

Pure, and the only part with real logic.

- [ ] Write `synopsisInput(input: { transcript, files, findings })` returning a bounded structured
      payload: what the person asked (user entries), what the agent did (tool entries, collapsed by
      kind), which files changed, and the findings still open.
- [ ] Bound it explicitly. Keep the first user message (the original intent) and the most recent
      entries, and collapse the middle into counts — a session's beginning and end matter more
      than its middle. Name the cap as a constant with a comment saying why.
- [ ] Collapse repeated tool calls: twenty `Read`s are "read 20 files", not twenty lines.
- [ ] Tests: an empty transcript yields an empty payload (not a crash); a long transcript is capped;
      the first user message survives capping; tool runs collapse; findings are included.

### Task 3: The `Summarizer` port

- [ ] Add to `core/ports.ts`:
      `export interface Summarizer { summarize(input: SynopsisInput): Promise<string> }`.
- [ ] Document on the interface that it must not throw into a turn, and that the agent is
      deliberately not the implementation.

### Task 4: `adapters/model/summarizer.ts`

- [ ] Implement with `generateText` over `createModel`, mirroring `adapters/model/reviewer.ts`'s
      construction (but with no tools — this is one call, not a tool loop).
- [ ] Give it a system prompt that asks for prose, a few sentences, no bullet-point restatement of
      the transcript. Put the prompt in `prompts.ts` beside `REVIEW_SYSTEM_PROMPT`.
- [ ] Test with `ai/test`'s `MockLanguageModelV4`, the way `tests/adapters/model/reviewer.test.ts`
      does: assert what the model was shown, not what it said.
- [ ] Test that a model error becomes a rejected promise the caller can catch — not a thrown
      string, not a silent empty summary.

### Task 5: `app/session.ts` — holding and refreshing it

- [ ] Add `synopsis: { text: string; at: string } | null` to `SessionState` (`core/types.ts`),
      defaulting to null.
- [ ] Add `summarize(): Promise<void>` to the `Session` port and implement it: build the input,
      call the port, set state, catch everything.
- [ ] Call it on `resumeSession`, after history has replayed — resuming is the moment the question
      "where was I" is actually being asked.
- [ ] Do **not** call it on every turn. It is a model call; it earns its cost on resume and on
      demand.
- [ ] Tests in `tests/app/session.test.ts` with a fake `Summarizer`: it runs on resume; a
      summarizer that throws leaves the session working and `synopsis` null; the input carries the
      changed files.

### Task 6: Route and UI

- [ ] `POST /synopsis` in `adapters/web/server.ts` calling `session.summarize()`, answering `ok`.
      Follow `/file/hide`'s shape. Test it with the existing `fakeSession` harness.
- [ ] Render at the top of `ConversationPanel.tsx`: the text, when it was made, and a button to
      remake it. Dismissible, and absent entirely when null.
- [ ] Keep it visually distinct from a transcript entry — it is Turnstile talking about the
      session, not a message in it.

### Task 7: Verification

- [ ] `bun run typecheck && bun run lint && bun test` — `tests/architecture.test.ts` stays green.
- [ ] `bun run simulate` still drives the fake session (add a fake `Summarizer` to
      `scripts/simulate.ts`).
- [ ] Live: run a real session, quit, resume it, and confirm the synopsis appears and describes
      what actually happened.
- [ ] Live: unset `OPENROUTER_API_KEY` and resume again. The session must open normally with no
      synopsis and no error.
