# Plan Panel and Todos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** See what the agent intends to do and how far through it is. Two gaps today: the agent's
`TodoWrite` calls are invisible (`core/activity.ts` treats them as a generic tool, so a long plan
shows as "using TodoWrite"), and a plan under review renders as raw markdown in
`PlanReview.tsx:48`.

**Architecture:** `TodoWrite`'s input is already in hand at `adapters/agent-sdk/client.ts`'s
`titleFor(name, input)` — the SDK hands over the tool name and its input together. Capture it
there, emit a new `AgentEvent`, hold the latest list on `SessionState` (TodoWrite replaces the
whole list on every call, so this is a replace, not a merge), and render it. Parsing the input is a
pure function in `core/todos.ts`.

**Tech Stack:** TypeScript, Bun, React, `bun:test`, existing ports-and-adapters architecture (see
`CLAUDE.md`).

**Independent of:** the session-synopsis and highlight-to-ask plans.

## Global Constraints

- `core` stays pure — `core/todos.ts` parses a value, touches nothing.
- `adapters/web/ui/*` may import only from `core` or itself.
- **The todo list is the agent's, not Turnstile's.** It is displayed, never edited. There is no
  endpoint to change a todo; the agent owns its own list and a second writer would desynchronise
  it silently.
- **`TodoWrite` is an undocumented shape from someone else's program.** Parse defensively: an
  unexpected payload yields an empty list, never a crash and never a half-rendered panel.
- No new dependency. This is a React list.

## Known unknowns, to settle before building

- **Does `TodoWrite` actually reach the adapter with its input intact?** Everything here rests on
  that and it has never been observed in this codebase — `grep -rn TodoWrite src/` finds nothing
  today. Task 1 answers it before a line of production code is written.
- **Whether "a structured plan renderer" is real.** The plan text is free-form markdown the agent
  wrote; there is no schema to render structurally. See Task 6 — the honest version of this is
  better typography plus the todo list beside it, not a parser that invents structure.

---

### Task 1: Prove `TodoWrite` arrives, before building anything on it

The whole plan depends on an observation nobody has made yet. Make it first.

- [ ] Add a temporary `process.stderr.write` in `adapters/agent-sdk/client.ts` where `tool_use`
      blocks are handled, dumping `name` and `input` verbatim for any tool whose name contains
      "todo".
- [ ] Run a live session (`bun src/cli/main.ts` against a scratch repo) and give the agent a task
      big enough that it writes a todo list — several steps across several files.
- [ ] Record the exact observed shape in this file: field names, the status values actually used,
      whether an `activeForm` is present.
- [ ] Remove the temporary logging.
- [ ] **If `TodoWrite` never appears, stop and report that.** The rest of this plan is unbuildable
      and the panel would be permanently empty.

### Task 2: `core/todos.ts` — parsing what was observed

- [ ] Define `Todo = { content: string; status: TodoStatus; activeForm: string | null }` in
      `core/types.ts`, with `TodoStatus` matching the values actually seen in Task 1.
- [ ] Write `todosFrom(input: unknown): Todo[]` — tolerant, in the shape of `core/lsp.ts`'s old
      defensive parsers: anything unrecognised is dropped rather than thrown on.
- [ ] Tests: the real shape from Task 1 parses; an unknown status falls back to `pending`; a
      non-array, a null, and an array of junk each yield `[]`; entries missing `content` are
      dropped rather than rendered blank.

### Task 3: The event and the state

- [ ] Add `| { kind: 'todos'; todos: Todo[] }` to `AgentEvent` in `core/types.ts`.
- [ ] Add `todos: Todo[]` to `SessionState`, defaulting to `[]`.
- [ ] In `app/session.ts`'s `onEvent`, handle the new kind by replacing `state.todos` wholesale —
      `TodoWrite` sends the entire list every time, so merging would resurrect deleted items.
- [ ] Clear `todos` on `newSession` and on `resumeSession` (a previous conversation's plan is not
      this one's).
- [ ] Tests in `tests/app/session.test.ts`: an event sets the list; a second event replaces rather
      than appends; a new session clears it.

### Task 4: Emit it from the adapter

- [ ] In `adapters/agent-sdk/client.ts`, where `tool_use` blocks are translated, recognise
      `TodoWrite` and emit the new event alongside the existing tool entry.
- [ ] Keep emitting the tool entry too — the transcript should still record that the call happened.
- [ ] Test in `tests/adapters/agent-sdk/client.test.ts` by scripting a `TodoWrite` `tool_use` block
      through the injected `queryFn`, the way the existing tests script other tools.

### Task 5: The todo list in the UI

- [ ] A `TodoList.tsx` under `adapters/web/ui/`: one row per todo, status shown by state
      (pending / in progress / done), and a count — "3 of 7".
- [ ] Show it in the conversation panel, above the composer, visible whenever the list is non-empty
      — including while the agent works, which is when progress is worth watching.
- [ ] Use `activeForm` for the in-progress row when present ("Wiring the relay"), and `content`
      otherwise. That is what the field is for.
- [ ] Improve `core/activity.ts`: with todos in hand, the activity line can say what the agent is
      doing rather than "using TodoWrite". Update the test for `activityOf` alongside.

### Task 6: The plan under review

Read this before touching `PlanReview.tsx`.

- [ ] The plan is free-form markdown the agent wrote. There is no structure to parse, so **do not
      write a parser that invents one** — a heading-guesser that is right most of the time is worse
      than plain markdown, because the times it is wrong are silent.
- [ ] Instead: keep `<Markdown>`, and give the panel proper typographic treatment — readable
      measure, spacing, a distinct surface from the transcript.
- [ ] Show the todo list beside the plan when both exist. That is the structure, and it is real
      because it came from `TodoWrite` as data.

### Task 7: Verification

- [ ] `bun run typecheck && bun run lint && bun test`.
- [ ] `bun run simulate` — add todos to the fake state in `scripts/simulate.ts` so the panel can be
      iterated on without an agent.
- [ ] Live: a real session with a multi-step task. Confirm the list appears, that items move to
      done as the agent works, and that the activity line reads sensibly rather than "using
      TodoWrite".
- [ ] Live: start a second session and confirm the previous one's todos are gone.
