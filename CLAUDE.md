# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Turnstile is a code review companion for a coding agent. It drives Claude Code directly via the
**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — no separate protocol proxy sits
between Turnstile and the agent; the SDK spawns and owns the `claude` CLI subprocess itself,
and Turnstile talks its streaming message protocol directly.

Every session runs directly in the user's checkout, and the tree that checkout stood at when the
session started (uncommitted work included) is the session's **baseline**. The board is simply every file that differs from that baseline —
committed or not, whoever changed it. When a turn that changed something ends, a read-only
Claude Code reviewer (the same SDK, a second one-shot `query()`) reads every changed file with no
current review, holding it to the repository's own `CLAUDE.md` and skills, and returns typed
findings. The human
reads the diff, leaves line-anchored notes, and sends them to the agent when they choose
(`Session.sendNotes`). Nothing blocks: there is no gate, no approve and no reject.

**This is a pivot.** Turnstile began as a blocking turn-boundary review
gate: after each turn it held the agent until a human approved or sent back each change,
recorded verdicts in a run-keyed review ledger, and looped rejections back to the agent. All of
that (the gate, the ledger, verdicts, board states, review cycles, the risk advisor and pass
log, the shelved SQLite adapters) was removed, and none of it is in this repository.

This used to run as an ACP (Agent Client Protocol) client instead, spawning a separate
`@agentclientprotocol/claude-agent-acp` proxy process. That's gone — `src/adapters/acp/` was
deleted along with it. Turnstile has only ever targeted Claude Code, and driving it directly
through the SDK removes a whole layer (the ACP proxy) along with the friction that came with
it: an MCP-over-HTTP `propose_edit` tool needing a fresh server+transport per request, a
mutual-reference dance to hand the agent an HTTP URL that didn't exist until the web server
was listening, and multi-strategy subprocess-path resolution for a compiled binary. See "Known
gaps and follow-ups" below for what this migration left unfinished.

Read `README.md` for the product as a user sees it (the baseline, notes, the review,
configuration, failure behavior).

**Turnstile is a macOS desktop app, built with Tauri (`desktop/`).** It is not a CLI and not a
web app. Everything under `src/` compiles to one binary, `dist/turnstile`, which the desktop shell
runs as a sidecar in the folder the user opened (`desktop/src-tauri/src/sidecar.rs`), loading
the UI it serves into the app's window. `src/cli/main.ts` is that binary's entry point and takes
no arguments; `cli/` is a historical name for the composition root. Don't add subcommands,
flags or a browser-opening path. The browser is only for `bun run simulate`, a UI development
tool.

## Known limitation: one repo, one session per process

`runApp()` in `src/cli/app.ts` hardcodes `process.cwd()`, one `Session` and one server, so a
running process serves exactly one repository. A multi-tab design — several repos, or several
tabs on one repo, behind a single server with a browser-style tab bar — was prototyped
separately and is **not part of this repository**. It reached green verification with its UI
driven in a browser but was never merged, because of one unresolved bug: in the desktop app, clicking
"Browse…" to pick a folder did nothing. A capability/origin fix was applied and confirmed
compiled in — Tauri's default capability grants IPC only on the app's local origin, while that
work keeps the window permanently on the sidecar's own served ("remote") origin — but a live
retest showed the same symptom, so the root cause is still open. Anyone taking this on again
starts there, and from a design that predates the pivot away from review cycles.

## Commands

```bash
bun install                    # install deps
bun run typecheck              # tsc --noEmit
bun run lint                   # biome check .
bun run lint:fix               # biome check --write .
bun test                       # full suite (bun:test)
bun test tests/core/chunking.test.ts     # a single file
bun test -t "some test name"             # filter by test name (regex)
bun run build                  # bun build --compile -> dist/turnstile, UI embedded
```

Run the app during development through the desktop shell, from the repo root:

```bash
bun run desktop                 # tauri dev: rebuilds dist/turnstile, then opens the window
bun run simulate                # the UI alone, in a browser, against a fake session (no agent)
```

`OPENROUTER_API_KEY` (or whatever `openrouter.apiKeyEnv` in `.turnstile/config.json` names)
is only for answering a question about a selection (the model must support tool calling).
Nothing else uses OpenRouter: the review is Claude Code, authenticated like the agent, and
auto-mode is TypeSafe. The agent itself authenticates however the `claude` CLI
normally does (its own login, or `ANTHROPIC_API_KEY` in the environment) — Turnstile does not
manage that.
`TYPESAFE_API_KEY` (or whatever `typesafe.apiKeyEnv` names) is what auto-mode judges tool calls
with. Without it every tool call prompts; nothing fails to start.
`TURNSTILE_CLAUDE_CODE_EXECUTABLE` overrides which `claude` binary the SDK spawns, when its own
resolution needs help (see `resolveExecutable.ts` below); a packaged desktop build sets it to
its bundled `claude`.

No network access or API key is required to run the test suite — model calls sit behind the
`Reviewer` and `Asker` ports and are faked in tests. `bun run simulate` fakes them too, so the
UI can be driven with no model, no key and no git repository.

## Architecture: ports and adapters, enforced

Strict downward stack, and it is not just convention — `tests/architecture.test.ts` walks the
real import graph and fails the build on a violation:

```
core/       domain types, chunking, risk bar, notes, port interfaces — zero I/O
   ↑
app/        session.ts, board.ts, review.ts — the pipeline, against ports only
   ↑
adapters/   agent-sdk · git · model · web · fs — each may import core, never a sibling adapter
   ↑
cli/        composition root (main.ts, app.ts) — the only place allowed to know every layer;
            main.ts is the sidecar's entry point, not a command-line interface
```

- `core` cannot import `node:fs`, use `Bun.*`, or `fetch` (checked by the same test file).
- `app` cannot name a concrete adapter — it depends only on the interfaces in `core/ports.ts`.
- `adapters/web/ui/*` (the React bundle) may only import from `core` or itself — never
  server-side adapter code, since it ships into the app's webview.

When adding a capability, add or extend a port in `core/ports.ts` first, implement it under
`adapters/`, and wire it in `src/cli/app.ts` (the composition root) — don't reach around the
layers even for something that feels small.

### The pieces

- **`src/adapters/agent-sdk/client.ts`** — the Claude Agent SDK boundary. `connectAgentSdk`
  opens one long-lived, streaming-input `query()` per Turnstile session (the TypeScript SDK
  has no persistent session object of its own — streaming input, fed through an internal async
  queue, is the only supported way to keep one subprocess alive across multiple prompts) and
  exposes `AgentConnection` (`start`/`prompt`/`cancel`/`answerPermission`/…), translating the
  SDK's `SDKMessage` stream into `AgentEvent`s. Deliberately dumb, same as the ACP client it
  replaced: it does not decide anything, just translates — all gating/write logic lives in
  `app/session.ts`'s `runToolWrite`, reached through the `writeFile` callback
  `AgentConnectionFactory` hands the connection at construction time.
  `Edit`/`Write` are disallowed unconditionally and the in-process write tool built by
  `buildWriteTool` (`tool()` + `createSdkMcpServer()` — no HTTP server, no per-request MCP
  transport) is the *only* way a session can touch a file.
  `canUseTool` gates every other tool call (Bash, etc.) the same way — the
  direct analog of ACP's `requestPermission` — but explicitly bypasses the write tool itself
  (`isWriteTool`): without that, `canUseTool` intercepts the write tool's own call before its
  handler (which already gates correctly) ever runs, silently deadlocking every write. Found
  live against a real session, not by any unit test — the fakes didn't model the SDK's actual
  timing closely enough to catch it.
  `start()`/`newSession()`/`loadSession()` all resolve *immediately*, never waiting on anything
  the SDK sends back: confirmed directly against a real `query()` that in streaming-input mode
  the subprocess does not emit `system/init` (or assign/reveal a session id at all) until the
  first message is actually pulled off the prompt iterable — which cannot happen before
  `start()` resolves, since nothing has been prompted yet. `Options.sessionId` is what makes
  resolving immediately safe rather than a guess: a fresh UUID chosen up front becomes the
  real, resumable session id the moment the SDK does create the conversation.
  If the `claude` process ends on its own (killed — macOS SIGKILLs a binary whose code signature
  it no longer trusts — crashed, or exited), `processDied` fails the turn in flight with the
  reason (or reports it as `agent-error` between turns), and the next `prompt()` opens a new
  query on the same conversation: `resume` once the SDK has begun it, the same fresh
  `sessionId` if it never did. Before this, a dead process left the turn "thinking" forever.
- **`src/adapters/agent-sdk/resolveExecutable.ts`** — locates the `claude` binary the SDK
  should spawn, when its own optional-dependency resolution needs help. Run from source
  under Bun (as `bun run desktop` does before it compiles, and as tests do) needs no help (a real `node_modules` sits alongside it). Compiled
  (`bun build --compile`), `import.meta.url` resolves to a virtual `/$bunfs/...` path with
  nothing real beneath it, so `findUpward` walks up from `process.execPath` (the compiled
  binary's own real, on-disk location) looking for the platform package's `claude` binary in
  `node_modules` — the same directory-walk strategy the old ACP-era `defaultCommand()` used,
  now computing the target platform/arch at runtime rather than needing a per-platform build
  step. `TURNSTILE_CLAUDE_CODE_EXECUTABLE` overrides it outright. Only finds anything while the
  compiled binary still runs from inside the repo checkout — see "Known gaps" below.
- **`src/app/session.ts`** — the stateful core: owns `SessionState`, runs each turn (`turn()`),
  the queued-message system for talking to a busy agent, notes (`annotate`/`sendNotes`), and the
  session lifecycle. A turn is: prompt, wait for the stop reason, refresh the board, go idle —
  there is no gate. `writeFile` (`runToolWrite`) is the one path a file gets written through; it
  writes immediately and calls `afterPossibleEdit()` (`refreshBoard`/`onEdit`/
  `diffRevision++`/`clearStaleNotes` — **not** the review, which waits for the turn to end). `onEvent` calls the same thing whenever any tool call
  other than a read or fetch completes (or fails), since the agent can change a file without the
  write tool — Bash (`sed`, a heredoc), `NotebookEdit`, an MCP tool, a subagent. Owns
  no I/O — everything arrives via the `SessionDeps` ports; `connection` is created per session,
  inside `openSession()` (which records the baseline via `Repository.open`): at a session's first
  prompt (`ensureOpened`), or straight away on `resumeSession` — and never at all for a project
  that is not a git repository.
  Notes are **explicit-send only**: `annotate` stores a note (anchored to root + path + line
  range + side, with the quoted line text), and nothing carries it to the agent except
  `sendNotes(text?)`, which marks every unsent note sent and runs a turn with the notes block
  ahead of the typed text (`core/annotations.ts`'s `promptWith`). Called mid-turn, it remembers
  exactly which notes were unsent at that moment (`requestedNotes`) and delivers them as the next
  turn; an ordinary `send` never carries notes.
  Notes **clear when their file changes**: `annotate` records `fileHash` (the whole file's
  `contentHash` via `EditTarget.read`), and `refreshAnnotations` — run after every possible edit,
  at turn end, and on opening a session — removes every note, sent or not, whose file no longer
  hashes the same (`core/annotations.ts`'s `staleNotes`). Notes without a `fileHash` predate this
  and are left alone.
  **Hidden files** work the same way: `hideFile` stores the file's `contentHash` through the
  `HiddenFileStore` port (`adapters/fs/hidden.ts`, `.turnstile/hidden.json`, keyed by session id),
  and `refreshHidden`, which runs everywhere `refreshAnnotations` does, shows again any file whose
  hash has changed (`changedSince`, which `staleNotes` is built on). The UI keeps hidden files out
  of the review rail's list; the project tree and the file's own tab still mark them.
- **`src/app/board.ts`** — `captureBoardFor(handle)` (the base/next snapshot pair + deltas, base
  from `Baseline.resolve()`) and `chunksOf` (deltas → parsed patches → chunks). The single source
  of truth for "base and next," used by the board, the background review pass, and the diff
  pane so they can't drift onto different trees. There is no attribution filter: every delta is
  on the board.
- **`src/app/editResolution.ts`** — `resolveEdit` and `proposedContent`, the two pure functions
  `session.ts`'s write path uses to turn a `propose_edit` call's `old_text`/`new_text` into
  what the file should contain. `resolveEdit` rejects outright, before any write is attempted,
  when `old_text` doesn't match the file's current content (the property the agent's own
  `Edit` tool used to guarantee by erroring, which disappeared once Turnstile became the one
  performing the write). `proposedContent` uses a function replacer with `String.replace`
  rather than a plain string, so a `new_text` containing `$&`/`$$`/etc. is inserted literally
  rather than pattern-interpreted.
- **`src/app/review.ts`** — the review: **every changed file with no current review, in one
  run**. A file's review is current while its `contentHash` at `next` still equals the
  `StoredReview.fileHash` it was reviewed at (`reviewedHash`, supplied by the session), so a file
  is picked up exactly when it has never been reviewed or has changed since — the agent's edit, a
  hand edit, a checkout, another session. Skipped files (`skipReasons`) and unanalyzable chunks
  are never sent. The stale files go to `Reviewer.review` together, with their concatenated diff
  against the baseline (capped at `MAX_DIFF_CHARS`, saying so), and each comes back as a
  `StoredReview` carrying **the hash taken before the run** — so a file edited while it was being
  read keeps reading stale, never ready off a review of an older version.
  - **When it runs** (`session.ts`): at the end of a turn whose tree changed (`treeNow()` before
    the prompt, compared after — `reviewIfChanged`, on the failure path too), and on
    `Session.reviewNow()` (`POST /review`, the rail's **Review now**). Never mid-turn: reviewing
    work the agent is still in the middle of is reviewing something about to change, and each
    review is a whole agent run. Never on opening or resuming a session either — a file that
    drifted while the session was away reads "not reviewed" until one of the two triggers.
    `startReview` is `coalesce`d: a trigger that lands mid-run schedules exactly one more.
  - **State is derived, not accumulated.** `session.ts` keeps `reviews` (the `StoredReview`s by
    file), `reviewing` and `failed` (by file), and the board as last read per root (`boards`:
    chunks, skips, and each changed file's hash from `board.ts`'s `fileHashes`). `render()`
    rebuilds `chunks` and `fileFindings` whole from those through `core/livechunks.ts`'s
    `liveChunks` on every change. It replaced `reconcile`/`markAnalyzing`/`markReady`/
    `markFailed`, which carried analyses across recomputes by chunk content key and needed a
    cache lookup to know anything after a restart.
  - **Persisted per session** through the `FindingStore` port (`adapters/fs/findings.ts`,
    `.turnstile/findings.json`, keyed by session id like notes and hidden files), and loaded in
    `switchTo` — so a resume shows every review that still matches its file, and nothing else.
    A late result from a session that has since been left is dropped (`live()`).
  - **Findings onto chunks:** `core/findings.ts`'s `assignFindings` puts each finding on the first
    chunk its line range overlaps; the chunk's `analysis` is `{riskLevel: levelOf(its findings),
    findings}`, and `riskLevel` keeps tab sorting, badges and tree dots working. A finding in
    another file (a caller the change broke) goes on the file's change when there is only one;
    everything else that lands on no chunk goes to `SessionState.fileFindings`, shown at the top
    of the file pane and counted toward the file's level (`ChangedFiles.tsx`'s `worstRisk`).
  - **Failure:** `onFailed` records the reason per file; `liveChunks` shows `pending` with
    "Review failed: …". The next editing turn or **Review now** retries it.
- **`src/adapters/agent-sdk/reviewer.ts`** + **`src/core/reviewSubmission.ts`** — the reviewer:
  one `query()` per review, run in the checkout, **read-only**, returning typed findings
  `{path, startLine, endLine, severity, title, message}`.
  - **Why Claude Code and not a model call:** the repository already tells a Claude Code agent how
    it wants to be worked on — `CLAUDE.md`, project and user skills — and a review should hold the
    change to exactly that. `settingSources` is left at its default (everything, like the CLI) and
    `skills: 'all'`. This replaced YAML rules kept outside the checkout plus a per-rule verdict
    from an OpenRouter tool loop: the rules mostly restated what skills already enforce, and a
    file no rule governed was never reviewed at all.
  - **Read-only:** `tools: ['Read','Grep','Glob','Bash','Skill']`, `disallowedTools` for the edit
    tools, `Agent` and the web tools, and a `canUseTool` that allows the submit tool, `Skill`, and
    anything `core/toolSafety.ts`'s `isReadOnlyCall` vouches for (so `git log`/`grep` work and
    `rm`/a redirect do not). `reservedPathIn` first, and `protectionOptions` (exported from
    `client.ts`) keep it out of Turnstile's state exactly as the agent is.
  - **`persistSession: false`**, so a review never lands in `~/.claude/projects` or the resume
    picker. Verified live: no session file is written.
  - **Streaming input, not a string prompt:** in-process MCP tools and `canUseTool` answer over the
    control channel, so the prompt iterable yields one message and stays open until the result.
  - **`submit_findings`** (in-process, `tool()` + `createSdkMcpServer`, the `buildWriteTool`
    pattern) is the only way it answers. Its handler runs `groupFindings`, which files every
    finding under a reviewed file — its own `path` when that is one, otherwise the `cause` it must
    name — and refuses a path outside the root, a bad line range or an empty title/message, all
    at once, as the tool result, so the model corrects within the run. The first accepted
    submission is the answer; a run that ends without one throws (`maxTurns`, the timeout via
    `abortController`, or just stopping).
  - **The prompt** (`REVIEW_SYSTEM_PROMPT`, appended to the `claude_code` preset): report only
    what the change introduces; hold it to `CLAUDE.md` and skills; grep every use of a changed
    export, tests included (without this a live test caught a broken test call 1 run in 3; with
    it, 8 in 8 — measured under an earlier prompt, and kept); empty is the expected answer.
  - **Verified live** against a scratch repo with a CLAUDE.md convention, a project skill and a
    broken caller: all three were found, the skill cited by name, the caller filed under the
    change via `cause`, in about 40 seconds.
- **`src/adapters/model/asker.ts`** + **`src/core/ask.ts`** — "highlight some code and ask about
  it". Answered in a card set into the document under the lines it is about. Threaded — you can
  ask a follow-up. Three ways in:
  - **Select the code with the cursor** (`editor/selectionAsk.ts`). This is the instinct most
    people have, and the one the feature was asked for by. Releasing a mouse selection opens the
    full composer on those lines straight away — **Leave note** or **Ask** — on every file,
    changed or not. (A pill to press first was tried and read as a step that decided nothing.)
  - **Drag the line-number gutter**, type, and press **Ask** instead of **Leave note** — a
    second verb on the gesture that already existed.
  - **A header button** asks about the whole file, which rides at the top of the document beside
    the file-level findings.

  Selecting code in these panes means editing it, which is why note-taking moved to the gutter
  in the first place, and the pill does not take that back: it adds nothing to the selection,
  steals no focus (`mousedown` + `preventDefault`, since a click would collapse the selection
  before the handler ran), and typing or clicking away behaves exactly as before. It appears on
  release rather than on every selection change, so dragging across twenty lines does not strobe
  a button along behind the cursor. `Pending.intent` decides which verb the composer leads with.

  **Both of these are fixed-position elements, not block widgets, and that is load-bearing.**
  The first attempt opened the question box as a widget inside the document and had to be
  rewritten: a widget changes the document's geometry, that is an editor update, an update
  re-reads the selection, and re-reading the selection puts the widget back. Each guard against
  that loop was another patch on it, and one of them still locked the renderer. Nothing outside
  the editor can feed back into it.

  The same applies to focus. CodeMirror re-asserts DOM focus on its content whenever it writes
  its selection back to the DOM, for as long as it believes it is focused — so a box that
  focuses itself in an effect loses the cursor a moment later, and the reader ends up typing
  into the file. `useSelectionAsk`'s `handOff` blurs the content while handling the event that
  raised the selection, which is early enough; an effect is not, since a child's effects run
  before its parent's. Known gap: auto-focus is unverified against a real foreground window —
  see below.
  - **The agent does not answer**, and that is the point. It cannot answer while it is mid-turn,
    which is exactly when you are reading its output and want to ask; and the question is not the
    work, so it should not cost the agent's context window. Its own `ask` config key, over
    OpenRouter, defaulting to a cheap, fast model.
  - **Read-only by construction**: `readOnlyTools` (`adapters/model/tools.ts` —
    `read_file`/`glob`/`grep` over `RepoReader`) is all it is offered. There is no write
    tool to withhold, and none to forget to withhold.
  - **It does not go through `Session`.** `POST /ask` reaches `serveApp`'s own `asker` dep, wired in
    `cli/app.ts` like everything else. No turn, no write, no `SessionState` field — which is what
    makes asking mid-turn work by construction rather than by careful handling. Built per call, so
    a missing API key fails one question rather than the app's start, and comes back as a 409 the
    card renders.
  - **Nothing is persisted.** Threads live in `adapters/web/ui/editor/askMemory.ts` at module scope,
    keyed by the same `tabKey` `scrollMemory` uses: they survive switching tabs (both panes are
    keyed per tab, so switching unmounts everything else holding them) and die with the page. An
    answer is deliberately not a note — notes are what survives, reaches the agent and becomes
    work, and blurring the two would make the board's record of what was asked for mean less. A
    follow-up therefore sends the whole thread back with it, which is what lets the server stay
    stateless here.
  - **Both document surfaces, identically.** `editor/markup.tsx`'s `useMarkup` owns the gutter
    drag, the cursor selection, the composer, notes and ask cards for both `CodeDocument` (a board
    file) and `PlainCode` (a file opened from the tree); each surface keeps only its own bands,
    folds and findings. Whether the agent touched a file has no bearing on wanting to tell it
    something about the file, so a note on an untouched file is kept, shown and sent like any
    other (`session.annotate` never checked the board). `ContextFileView` carries the same note
    count and **Send notes**/⌘⏎. Such notes are listed in the project tree's "Notes on other
    files" (`orphanedAnnotations`), each opening its file. The one exception: before a session
    has opened there is nowhere to keep a note, so a tree file offers only **Ask** until then —
    the same guard its save uses. `Composer`'s two verbs are both optional for that reason, and
    the plan document uses the other half: a note, and no "Ask", since the asker reads its
    subject off disk and a plan is not a file.
  - Known gap: a thread is anchored to line numbers, not content, so unlike a note (which carries
    `lineText` and retires itself when the file moves) it keeps pointing at whatever those numbers
    now hold. Page-lifetime state, so the window is small.
  - Known gap: **whether the question box actually takes the cursor is unverified.** It lands —
    instrumentation confirms the focus call succeeds — but every attempt to confirm it *survives*
    was made in a backgrounded automation tab, where `requestAnimationFrame` is suspended and
    focus behaves unlike a real window. If it turns out not to stick, the fix is in
    `useSelectionAsk`'s `handOff` and `parts.tsx`'s `useTakesTheCursor` — seven other approaches
    were tried before the current one, and none of them held.
- **Plan mode** — `ExitPlanMode` → `canUseTool` (`agent-sdk/client.ts`, special-cased ahead of
  everything else) → `requestPlanApproval` (`app/session.ts`), which parks the plan in
  `SessionState.planReview` and blocks on a promise held in `resolvePlanReview`. Approving
  returns `{decision: 'allow'}` and flips the permission mode back; refusing returns
  `{decision: 'reject', reasoning}`. **The refusal is a tool result, not a prompt** — it is
  delivered inline to a call the agent is still inside, which is why it never goes through
  `turn()` and why the compose box (which would queue it) is the wrong place to type it.
  The plan is **read as a document**, not as a modal: an entry pinned at the top of the review rail
  (`ChangedFiles.tsx`) over `PlanView.tsx` → `PlanDocument.tsx`. It was a `permission-overlay`
  modal until this change, which made the one document worth marking up the only one you could
  not.
  **Rendered markdown, not CodeMirror.** The first attempt put it on `PlainCode`, which meant
  reading a pure-prose document through a monospace gutter and parsing `##` by eye. `core/planBlocks.ts`
  splits the plan into blocks (blank-line separated, fences kept whole), each rendered with the
  same `Markdown` the transcript uses, each carrying the source lines it came from. Two ways to
  object to a part of it, because two instincts exist: **highlight the words**, or **drag the
  margin** beside a block. Both end as a note against source *lines* — the reader argues with the
  rendering, the agent is handed line numbers, because it is about to revise the plan as text.
  `quotedLines` is what keeps that honest: it flattens a block line by line, keeping a note of
  which line every character came from, and looks the highlighted passage up in it, so a note on
  one step of a six-step list says "lines 13-14" rather than naming the whole list.
  **Plan mode gates every tool, not just the write tool.** It used to check `isWriteTool` and
  nothing else, so `propose_edit` was refused while `Bash` fell through to the denylist and
  auto-approved — an agent restricted to planning could not use the write tool and could still
  write anywhere in the checkout with `cat >`, `sed -i` or a heredoc, silently. Found in the
  wild, not by a test: an agent reported routing around the refused write tool "via shell
  instead". `core/toolSafety.ts`'s `isReadOnlyCall` is the fix, and it is an **allowlist**,
  because auto-mode lets through whatever the user's statements don't describe, and plan mode's
  whole promise is that nothing happened at all. A plan-restricted call goes to the human
  without asking auto-mode.
  Declining is not denying: the call goes to the human with `plan-mode` as the
  `PermissionCause`, so installing a dependency mid-plan stays possible and stops being silent.
  The OS sandbox cannot do this job — `buildOptions` runs once per query, and the mode changes
  inside a live one, including from inside `canUseTool` itself when a plan is approved.
  The classifier is text matching over shell, not parsing, and can be fooled by an operator
  inside quotes. It is a gate in front of a human, not a
  sandbox.
  **`buildPlanTool` is why the plan file no longer costs a prompt.** `Edit`/`Write` are
  disallowed outright and `propose_edit` is scoped to the repository, so the one file the
  harness asks the agent to write — its plan, in `~/.claude/plans/` — had no sanctioned route,
  and the model reached for `cat >`, which went through silently before the gate and cost a
  prompt after it. The tool is allowed during plan mode because writing the plan *is* planning,
  and it is safe to allow for a structural reason rather than a textual one: **the destination
  is built, not accepted.** `core/planFile.ts`'s `planFileName` keeps nothing but a basename,
  which is joined to the one directory the tool can write to — so there is no path to traverse
  out of, and nothing for a redirect-recognising heuristic to misparse. Confirmed live: the
  agent picks the tool over a shell redirect and raises no prompt.
  **A decided plan goes into the transcript** (`appendPlan`), because the tab is transient and
  without it the plan died with the decision: approving one erased what had just been agreed to,
  and a resumed session replayed the `ExitPlanMode` call as a bare tool row with `input.plan`
  discarded — which is what "resume an old session and nothing shows up" turned out to be.
  `agentEventsFromSessionMessages` now recovers the plan and its outcome from history (a refusal
  is the tool call's *error* result, which is how the reasoning reaches the agent), and neither
  path emits a tool row for `ExitPlanMode` — the plan's own entry stands in for it.
  **The last plan of a session comes back as a plan unless it was approved**
  (`PlanReviewState.recovered`). Two ways to get there and the reader wants the same thing in
  both: the session died mid-decision — where the stored result is Claude Code's own "the user
  doesn't want to proceed", written because the process went away rather than because anyone
  decided anything — or it was sent back and the agent never replaced it, answering in prose or
  asking a question instead. **Whether a refusal produces a revised plan was measured against a
  real agent and is not reliable**, which is why the rule is about the plan rather than about
  the agent's cooperation. `planRefusal` asks for a revision through `ExitPlanMode` explicitly,
  which helps and does not guarantee. An approved plan is the only one finished with.
  A recovered plan has no `canUseTool` call left to return to, so `approvePlan`/`rejectPlan`
  deliver the decision as the next prompt instead — which is exactly what the agent is waiting
  for, having been told to stop and wait to be told how to proceed.
  **What is said and what is shown are not the same text**, which is why `turn` takes a `shown`
  override. The agent gets the composed refusal (`planRefusal`, which quotes every note and
  explains itself); the conversation gets what the reader actually typed, with their notes
  beside it as notes — the shape `sendNotes` has always had. Sending the composed text to both
  put a message in the reader's own bubble that they never wrote. Approving sends no bubble at
  all: it is a click, not a sentence, and the plan's record says what happened.
  Three more things here are load-bearing and were each a bug first:
  - **`planRound` is a counter on the session**, not `state.planReview?.round + 1`.
    `requestPlanApproval` nulls `planReview` before it returns, so the revised plan always
    arrived to find nothing to count from and every round called itself the first.
  - **A pending plan must be settled when nothing is listening for the answer.**
    `abandonPlanReview` is called from `cancel`, the turn's own failure path, the `agent-error`
    event, `prepareSession` and `switchTo`. Neither `interrupt()` nor `processDied` settles an
    in-flight `canUseTool`, so without this the plan pins itself to the rail with nothing behind
    it. `switchTo` is the one that is easy to miss: a resume does not go through
    `prepareSession`, so an unanswerable plan followed the reader into the session they had just
    opened.
  - **Plan notes are ephemeral and live on `planReview`, never in `state.annotations`.** That is
    what keeps them out of `unsent`, `staleNotes`, `refreshAnnotations`, `orphanedAnnotations`,
    the review rail's counts and `.turnstile/annotations.json` — there is nothing to filter, because
    they are never in the list. They are `Annotation`-shaped so `NoteBand` renders them unchanged,
    with `root: ''` and `path: PLAN_PATH`, neither of which may ever be resolved against the
    filesystem. A plan cannot be *asked* about for the same reason: `/ask` reads its subject off
    disk.
  Both "no approving over an outstanding note" and "a refusal needs a note or a message" are
  enforced in `server.ts` as well as in the page, because the page can be a round behind.
- **Turnstile's state is kept away from the agent** — `protectedDirs` (`~/.turnstile` and
  `<cwd>/.turnstile`, wired in `cli/app.ts`) in three layers. This once guarded the review rules
  too (a live run showed an agent `find`, `cat` and rewrite rules kept in the checkout); the rules
  are gone, the protection of the state directory stays, and the reviewer gets the same options.
  1. **`protectionOptions`** in `agent-sdk/client.ts` adds `Read(//dir/**)`/`Edit(//dir/**)`
     deny rules for Claude Code's file tools.
  2. **Claude Code's OS sandbox**: `filesystem.denyRead`/`denyWrite` on those dirs, and
     `allowWrite: ['/']` so nothing else is confined. `autoAllowBashIfSandboxed: false` keeps
     every Bash call going through `canUseTool`, so auto-mode still applies.
     `failIfUnavailable: false`.
  3. **`canUseTool`** first refuses any call whose serialized input names a reserved path
     (`core/toolSafety.ts`'s `reservedPathIn`). This is the only layer that covers
     Turnstile's in-process write tool.

  A Bash call with `dangerouslyDisableSandbox` goes to auto-mode like any other, with
  `runs_outside_sandbox` in what the judge is shown and a suggested statement for it — so leaving
  the sandbox is prompted only while the user keeps that statement. Why all
  three, verified live: the deny rules alone stopped `Read` and `cat`, but not `grep -r` from a
  parent directory or `python open()`; the sandbox stopped all of them. Network still works: each
  host comes through `canUseTool` as `SandboxNetworkAccess`.
- **`src/adapters/fs/repoReader.ts`** (`RepoReader`) — the asker's read-only view of the
  repository. It uses the same globby options as `projectTree.ts`, and every read goes through
  `safePath.ts`'s `readInside`. `grep` is a JS regex over listed files, with no `rg`. Every
  result is capped (`MAX_GLOB_PATHS`, `MAX_GREP_MATCHES`, and per-read lines in the asker's
  tool). The model adapter can't import `adapters/fs`, so `cli/app.ts` wires the reader in
  through `serveApp`.
- **`src/core/chunking.ts`** — splits a parsed patch into chunks: contiguous hunks per file,
  coalesced within a small line gap, split past a size budget. Chunk keys hash *content*, not
  line numbers, so relocating code keeps its identity.
- **`src/core/riskbar.ts`** — `skipReason`/`skipReasons`: which files aren't worth a review
  (docs, formatting, lockfiles, generated code, comment-only, mechanical renames); config lets a
  repo force `alwaysReview`/`neverReview`/`specPaths` globs. A skipped chunk still shows on the
  board, with the reason in place of an analysis.
- **Auto-mode** — whether a tool call runs without asking, judged against the user's own
  statements. It replaced `isAutoApprovedTool`, a regex denylist (`toolPermissions.denyPatterns`)
  plus a hardcoded `sudo` floor. Supplying `canUseTool` at all opts out of Claude Code's own
  read-only detection, so something has to let ordinary calls through, or Turnstile would prompt
  for everything.
  - **`core/autoMode.ts`** (pure): `AutoModePolicy` (`rules`, `threshold`, default 0.3),
    `SEED_RULES` (the setup screen's suggestions — `sudo` and the sandbox escape among them, since
    they used to be hardcoded), `callState` (the one JSON state every question is asked over: the
    call, and the repository root and home directory), `questionFor` (one Noul per statement,
    asking what the call would *do*), and `decide`: flag if **any** statement is at or above the
    threshold. A missing or out-of-range answer is `unavailable`, never an allow.
  - **`app/autoMode.ts`** (`createAutoMode`): holds the policy, asks the `CallJudge` within
    `typesafe.timeoutMs` (signalled *and* raced, so a judge that ignores its signal still can't
    hold the agent), turns every throw into `unavailable`, and memoizes `allow`/`flag` by
    `[toolName, input]` — cleared on save, never caching a failure. `trial` is the setup screen's
    dry run against an unsaved policy.
  - **`adapters/typesafe/judge.ts`**: one `systemOne` request per call, questions keyed by rule
    id. Built per call in `cli/app.ts`, like the asker, so a missing key is one `unavailable`
    verdict rather than a failed start.
  - **`adapters/fs/autoMode.ts`**: `~/.turnstile/auto-mode.json`, per user. It lives in a
    `protectedDirs` entry, so the agent can't rewrite the rules it's judged by. An unreadable
    file is no policy, which means every call prompts.
  - **`canUseTool`** order: reserved path (deny) → plan tool/write tool/`ExitPlanMode`/
    `AskUserQuestion` (special-cased) → plan mode (a call that does more than read goes to the
    human, auto-mode not asked) → `autoApprover.verdict` (only `allow` runs unasked). No
    `autoApprover` means auto-mode is off.
  - **UI**: `AutoModeSetup.tsx` opens by itself when no policy exists (once per page load) and
    from the top bar's **Edit tool permissions** button; **Start over** resets the draft to the seeds
    (nothing is saved until **Save**). The UI shows outcomes (**Asks**/**Passes**), never
    probabilities — on the setup screen, its dry run, and the prompt's flagged list alike. `GET`/`PUT /auto-mode`, `POST /auto-mode/trial`.
    Legacy `denyPatterns` (`loadLegacyDenyPatterns`, read off the raw config files since the
    schema dropped the key) are offered as statements to reword, never migrated silently.
  - **Unverified live**: no run against the real TypeSafe API has been made yet. The request
    shape is tested against the SDK with an injected `fetch`, and the UI through `simulate`
    (whose judge matches words). Worth measuring: added latency per tool call, and whether the
    seed statements score the way they read.
- **`src/core/toolSafety.ts`** — what sits in front of auto-mode and no statement can change:
  `reservedPathIn` (Turnstile's own state is refused outright) and `isReadOnlyCall` (plan mode's
  allowlist). Text matching over tool input, not sandboxes.
- **`src/core/permissionPrompt.ts`** — `describePermissionRequest`, which composes what the
  human is actually shown for a call that could not be auto-approved: the question, the command
  (or URL/path) verbatim, the agent's own description, and *why* it is being asked. The prompt
  used to be `callOptions.title ?? ` + `` `Allow ${toolName}?` ``, and the SDK bridge leaves
  `title` undefined for every call Turnstile gates — verified live: `title` was null every time
  while `displayName`/`description`/`blockedPath`/`decisionReason` were populated. So every
  prompt read a bare **"Allow Bash?"** with the command invisible, asking a reader to approve
  something they could not see. The sentence is composed here instead. The cause comes from what
  `canUseTool` passes in: `plan-mode`, `flagged` (auto-mode's verdict, whose fired statements
  also go out as the prompt's `flagged` list with their probabilities), `auto-mode-unavailable`
  (with the judge's reason) or `auto-mode-off`.
- **`src/core/livechunks.ts`** — `liveChunks`: derives what the sidebar renders
  (`pending`/`analyzing`/`ready`/`skipped`) whole, from the chunks, the skips and a `ReviewView`
  (is the file under review, why did its last review fail, its findings if its review is
  current). Nothing carries over between recomputes. `pending` means "no current review" — not
  queued — so the UI shows no spinner for it (`ChangedFiles.tsx`'s `fileRisk`).
- **`src/core/annotations.ts`** + **`src/adapters/fs/annotations.ts`** — notes, in
  `.turnstile/annotations.json`, keyed by **session id** (so they come back on a resume, the same
  way the cumulative diff does). Entries in older shapes (run-keyed, chunk-anchored) are ignored
  but carried over untouched on write.
- **`src/adapters/git/*`** — change detection, on git, in the user's own checkout.
  `repository.ts` (the `Repository` port) records each session's baseline at
  `refs/turnstile/baselines/<sessionId>` the first time it is opened (`open`), lists sessions by
  those refs (`sessionIds`), and creates no worktree or branch. It also adds `.turnstile/` to the
  clone's `info/exclude` (not `.gitignore`), so notes and the cache never show in the user's own
  `git status`, and `init()` is the "make this trackable" path the UI offers for a directory that
  is not a repository: `git init` plus a first commit.
  `rootRegistry.ts` holds exactly **one** root, the repository's top level, bound to the live
  session (`activate(root, sessionId)`), and `rootFor` answers null for anything outside it —
  `runToolWrite` refuses those writes.
  `snapshots.ts` captures a tree through a unique scratch `GIT_INDEX_FILE` (`read-tree HEAD`,
  `add -A`, `write-tree`), so a capture never touches the user's index/HEAD/stash and an agent's
  own commit cannot hide its work (both sides of every delta are trees). Untracked build output
  is kept out by `config.untrackedExcludes` (`target/`, `node_modules/`, … by default), passed
  as `-c core.excludesFile=<generated file>` with the user's own global excludes copied in
  first, since that option replaces rather than extends. `delta.ts` diffs two trees with
  `git diff --raw -M -z`, dropping gitlink entries (a nested repository) and Turnstile's own
  state directory. `baseline.ts` resolves the session's baseline: the tree recorded at
  `refs/turnstile/baselines/<sessionId>` at its first prompt, then HEAD, then the empty tree. Both sides of every delta are trees, so an agent's commit never
  hides its work.
- **`src/adapters/web/server.ts`** + **`src/adapters/web/ui/*.tsx`** — the UI. A real React app,
  bundled by `bun build` directly (no Vite, no separate build step) and embedded into the
  compiled binary. State pushes from `Session.onChange` over what `server.broadcast` exposes.
  The layout follows the "Turnstile Sidecar" Claude Design handoff: a slim header
  (`TopBar.tsx`, a three-column grid with the agent's activity bar centered — one line, verb then
  target, from `core/activity.ts`'s `activityOf`; the conversation panel has no status line of its
  own), under it the tab strip — **every file the reader has open**, pulled up from the project tree
  or clicked in the rail alike (`OpenTabs.tsx`, rendered only when there are any), each carrying
  the same `.tree-dot-*` the project tree gives it (`ChangedFiles.tsx`'s `marksByPath`, shared by
  both so the two can never paint one file two colours; a file that is not on the board has no
  dot). It was two rows until this: the rail stood in for the board's tabs and the strip held only
  files the agent had never touched, `core/tabs.ts`'s `stillOpen` filtering out the rest so nothing
  was ever in both — which cost a file its tab the moment the agent touched it, and gave a file
  opened from the rail no tab at all. `App.tsx` keeps one `active` path and one `opened` list for
  it, where it used to keep `picked`, `contextPath`, `promoted` and a precedence rule between them;
  `activeFile` (is the active path on the board?) is all that decides whether the pane is the
  review one or a plain read. Then the workspace: the left panel beside the file pane, with the conversation docked beneath the file pane. On the left — folded to a thin rail by default (`usePanel('files', false)`), kept mounted while folded so its state survives, and opened by its rail or by ⌘K — the **review rail**
  (`ChangedFiles.tsx`'s `ReviewRail`, from the "Review rail" Claude Design handoff): the changed
  files, built from `/diff` plus the pushed chunks, in sections by `railGroup` — high, med, not
  reviewed yet, low, none, skipped — with low/none/skipped folded until opened, and whichever
  section holds the file on screen opening itself. Above them, while any file has a pending chunk
  (no current review), a **Review now** bar (`POST /review` → `Session.reviewNow`), disabled while a
  review runs or the agent is working. `changedFiles` sorts in that same order, so the
  rail reads riskiest first. **There is no J/K**: it walked the rail and moved the pane, which
  stopped making sense once what is open is the reader's own list — it was removed with the second
  tab row. A pending plan is pinned above the sections, and its arrival switches the rail back
  to them. Files marked reviewed sit in a
  last, folded "reviewed" section (styled like "none"); it comes back when the file changes again,
  or by the ↩ beside its row there — **never merely by being opened**. Opening one used to bring it
  back, in the rail and from the project tree both, which made reading destructive: there was no
  way to look at a file you had already read without un-reviewing it, so the marks came quietly
  undone as the reader browsed, and looked to a returning reader like a resume had lost them (the
  marks themselves persist correctly in `.turnstile/hidden.json`). The same panel also holds the project
  tree ("Turnstile Left Column (1a)" handoff): a **Changed / All files** switch at its top flips
  between the sections and `FilesPanel.tsx`'s `ProjectTree` (dots tinted by each changed file's
  `railGroup`, a filter, "Notes on other files"); ⌘K switches to it and focuses the filter. Both
  views stay mounted, the other one `hidden`, so folds, scroll and filter survive the switch. Then the
  file pane (`FileView.tsx` → `FileDocument.tsx`: the whole file with its changes marked, a card
  per chunk listing its findings (`FindingList`), file-level findings as a card at the top of the
  document itself — a block widget, so they scroll with the file rather than sitting above it —
  drag-to-note on any line, "Send notes" / ⌘⏎), and below it the conversation
  (`ConversationPanel.tsx`, resizable by dragging its top edge, hideable to a thin bar along the
  bottom that still shows status and the queue; its compose box also sends notes). It starts at
  a third of the height; there is no full-screen mode. Hidden/shown
  panel state, the conversation's height (as a fraction) and the open tabs are remembered in the webview's `localStorage` — which in
  practice means **per run, not across restarts**: `serveApp` binds `port: options.port ?? 0`
  and `cli/app.ts` passes no port, so every launch is a fresh ephemeral port and therefore a
  fresh origin. Deliberate, not a bug to fix in passing: pin the port, or move the state into
  `.turnstile/`, if that ever needs to change. Notes are sent with `POST /notes/send`, and a sent message's transcript
  entry carries the notes themselves (`TranscriptEntry` `user` → `notes`) so the bubble shows
  what was asked.
  Also serves the read-only file explorer's two endpoints, `GET /files` (the flat path list)
  and `GET /files/content?path=...` (one file's text), backed by the `ProjectTree` port below.
  They serve the repository once a session has opened, and the opened folder before that.
  There is no `/mcp` route any more — the write tool lives entirely in-process now, inside
  `adapters/agent-sdk/client.ts` (`buildWriteTool`), with nothing to mount over HTTP.
- **`src/adapters/fs/projectTree.ts`** — the `ProjectTree` port's adapter: every non-ignored
  project file, via `globby` with `gitignore: true` (nested `.gitignore`s included), `.git`
  excluded at every depth (`**/.git`, not just the root one — a nested `.git` is a submodule
  or, in this repo, a worktree checkout), and symlinks never followed. Deliberately separate
  from `EditTarget` — one is the narrow read/write surface the agent's write tool uses, the
  other a read-only view of the whole tree, and the two ports should stay easy to tell apart.
- **`src/adapters/fs/safePath.ts`** — `resolveInside`/`readInside`, the traversal guard every
  filesystem-touching adapter shares (`ProjectTree.read` today) so a path supplied by the page can
  never resolve to somewhere outside the project root. Joins the path against root and checks
  the result stays prefixed by it (catches `..` after normalization), then, before reading,
  resolves the real path (following any symlinks) and re-checks that too — closing the gap a
  lexical check alone leaves open when a path inside root is itself a symlink pointing out.
- **`src/core/filetree.ts`** — `buildFileTree`: reshapes `ProjectTree.list()`'s flat path list
  into the nested tree the file explorer panel renders, in one pass so expand/collapse in the
  UI is pure client state rather than a fetch per folder click. Pure and side-effect-free, so
  it lives in `core` next to the rest of the domain logic rather than in the UI that consumes
  it.

### Change detection: git, in the user's checkout

Change detection runs on git. For a stretch it ran on a filesystem-scanning
"watcher" that re-implemented git badly; that was deleted. The folder the desktop app opened
is the one and only root, and a directory that is not a git repository opens no session at all
(`SessionState.tracking`), with the UI offering to initialize one.

Until this design, every session ran in its own git worktree (`.turnstile/worktrees/<id>` on a
`turnstile/<id>` branch, with `.worktreeinclude` copying and a `worktree.setupCommand`, discarded
on close if unused). That isolation only existed for the review gate; once the gate went it cost
more than it gave, and it was removed. Leftover worktrees and branches from it are left alone.

Things this design means, worth knowing before changing it:
- The agent works **in the user's checkout**, the folder the desktop app opened. Its
  edits land there directly; Turnstile creates no branch and never commits.
- **The baseline is recorded at the first prompt**, as a commit (on no branch, parented on HEAD
  when there is one) at `refs/turnstile/baselines/<sessionId>`, capturing the checkout through a
  scratch index — uncommitted and untracked work included, so what the user already had in
  progress is never on the board. It lives in git, so it survives app restarts and resumes with
  nothing persisted by Turnstile. `Repository.open` records it only if the ref is absent, so a
  resumed session keeps measuring from where it first started.
- A new session's baseline and agent connection are created by its **first prompt**
  (`ensureOpened` in `session.ts`), not by `start`/`newSession`, so an app start or "new session"
  that never sends anything leaves nothing behind. `resumeSession` opens immediately — replaying
  history needs the agent. Session ids are minted by `session.ts` (`mintSessionId`) before the
  agent exists, so the baseline can be named after them. `SessionDeps.openAt: 'start'` opens
  eagerly instead; only tests use it.
- Past conversations are listed through `AgentHistory` (the SDK's session files for the launch
  directory), filtered to the ids that have a baseline ref — a plain `claude` session run in the
  same directory has nothing to measure a board from.
- There is no reset command. Notes, hidden files and stored reviews live in
  `.turnstile/annotations.json`, `hidden.json` and `findings.json`; deleting those files forgets
  them. The baseline refs are what make a session resumable.

### The board is cumulative and survives restarts

The board is everything the checkout differs from the session's baseline by — so resuming a
session, or restarting the app and resuming it, shows its whole cumulative diff again, with its
notes and every review that still matches its file (`.turnstile/findings.json`). Nothing about the
board itself is persisted: it is recomputed from git (the baseline ref and the checkout) every
time.

### Session lifecycle, in one pass

`session.start()` checks the project is trackable (`Repository.status`; anything but `'git'` stops
here, recorded in `SessionState.tracking`) and mints a session id — nothing else. The first prompt
then opens the session (`Repository.open`, which records its baseline), activates the repository
as the one root, and opens an agent connection running in the opened folder (one long-lived
streaming-input `query()`, resolving immediately with that id — see the agent-sdk client above).
`newSession`/`resumeSession` leave the live session, then open the other conversation — lazily
for a new session, immediately for a resume. `session.send(text)` loops: run one `turn()`, then
deliver anything queued while the agent was busy (and notes the human asked to send mid-turn) as
another turn, until nothing is left. `turn()` prompts, waits for the stop reason, refreshes the
board, starts the review if the turn changed the tree, and goes idle.

## Testing conventions

- Bun's built-in test runner (`bun:test`), colocated under `tests/` mirroring `src/`'s
  `core`/`app`/`adapters` layout.
- `tests/architecture.test.ts` is a real test, not a lint rule — it will fail CI if a layering
  rule above is violated. Run it after moving files between layers.
- Ports are faked in tests (see `tests/app/*.test.ts` for `Reviewer`/`FindingStore`/
  `AnnotationStore`/etc. fakes) — no real model or subprocess is needed to exercise
  `createSession`. The fake snapshots give the tree a new id on every change (`setDeltas`,
  `setContent`), because the review only runs after a turn whose tree changed: a test that wants
  a review makes its change inside the prompt (`duringPrompt`/`duringTurn`), not before it.
  `tests/adapters/agent-sdk/reviewer.test.ts` drives `connectReviewer` with a scripted `query()`
  that calls `submit_findings` through the in-process MCP server's own registry — the handler
  the real CLI reaches — including a refused submission followed by the corrected one.
- `tests/adapters/agent-sdk/client.test.ts` drives `connectAgentSdk` with an injected `queryFn`
  — a fake async generator scripting `SDKMessage`s and recording every `Options`/streamed
  prompt the real `query()` would have received — rather than spawning a real subprocess or
  calling a real model; `buildWriteTool` is tested even more directly, by calling its
  `.handler(...)` with no connection involved at all.
  `tests/adapters/agent-sdk/resolveExecutable.test.ts` covers the directory-walk fallback the
  same way the old `defaultCommand.test.ts` covered ACP's — the compiled-binary case itself
  can't be faked in a unit test, only the walking logic that takes over once it's needed.
- These adapter-level fakes are necessarily a simplification of the real SDK's timing, and two
  real bugs in this adapter were found only by running it live against a real session, not by
  any test here — see "Known gaps and follow-ups" below. Treat a green `client.test.ts` as
  necessary, not sufficient, for a change to this adapter; a live smoke test (`bun run desktop`,
  opening a scratch repo) is worth doing before trusting a nontrivial change to it.

## Known gaps and follow-ups (ACP → Claude Agent SDK migration)

The migration off ACP (see "What this is") landed with the automated suite green and live
verification, but it left some things deliberately unfinished. Read this before assuming any
of the following just works:

- **`desktop/` bundles/locates its own `claude` binary now, fixed after being broken by the ACP
  migration.** `desktop/scripts/prepare-sidecar.mjs` copies just the native `claude` binary
  (from the installed `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` package) into
  `desktop/src-tauri/resources/claude-cli/`, bundled as a Tauri resource
  (`tauri.conf.json`'s `bundle.resources`). `desktop/src-tauri/src/sidecar.rs`'s
  `bundled_claude_path()` resolves that path at runtime via `resource_dir()` — real only in a
  packaged `tauri build`, never under `tauri dev` — and `start()` sets
  `TURNSTILE_CLAUDE_CODE_EXECUTABLE` to it, the same var `resolveExecutable.ts` already reads
  ahead of any other resolution path. No `src/` changes were needed for this. The old ACP-era
  version of this bundled the whole `claude-agent-acp` agent module plus a `bun` binary to run
  it under, and set three env vars (`TURNSTILE_AGENT_MODULE`/`TURNSTILE_AGENT_RUNTIME`/
  `CLAUDE_CODE_EXECUTABLE`, no `TURNSTILE_` prefix on the last) that nothing in `src/` read any
  more — that machinery is gone.
- **`resolveExecutable`'s compiled-binary fallback is verified on darwin-arm64 only.** It's
  written platform-generically (walks up from `process.execPath` for
  `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  computed at runtime, not baked in at build time), and there's no reason it shouldn't work the
  same way on Linux/other archs — but nobody has actually run a compiled build there yet.
  Separately, `desktop/`'s own packaged-build fix above hasn't been live-tested on Linux either.
- **The compiled-binary fallback only finds anything from inside the repo checkout** — same
  caveat the ACP-era `defaultCommand()` had for the identical reason. A real standalone install
  (a mounted DMG, `/Applications`, anywhere without the project's own `node_modules` reachable
  by walking up from the binary) has nothing to walk up to. This is no longer a live desktop
  bug: a packaged desktop install now sidesteps the walk entirely via
  `TURNSTILE_CLAUDE_CODE_EXECUTABLE` (see above). This bullet describes the walk's own inherent
  limitation in isolation — it would still apply to, say, a compiled binary copied out of the
  repo checkout by hand with no `TURNSTILE_CLAUDE_CODE_EXECUTABLE` set.
- **`SessionState.thinkingLevel` always reports `null` now.** No live SDK message was found
  that carries the agent's current reasoning-effort level the way ACP's `config_option_update`
  did. The UI already renders `null` gracefully (it's filtered out of the model/thinking-level
  status line), so this degrades silently rather than breaking — but it is a real loss of
  information versus the ACP-era behavior, not just a cosmetic gap.
- **Context-usage reporting went from continuous to end-of-turn.** ACP pushed `usage_update`
  events mid-turn; the SDK has no equivalent push event in streaming-input mode, only a
  pull-based `Query.getContextUsage()`. The adapter calls it once after each turn's result
  message. Fine for a status-bar figure, not a live meter — if a mid-turn context readout ever
  becomes a real requirement, this needs another look, not just a faster poll.
- **`tests/architecture.test.ts` only walks relative imports**, so a bare package import in
  `core` (the ACP SDK's `SessionId` type once leaked in that way, undetected) is not caught by
  it. Keep package imports out of `core` by hand.

## Known gaps (the Claude Code reviewer)

- **Verified live once, on a small repo.** Worth watching on real work: how long a review of a
  large turn takes against `timeoutMs`/`maxTurns`, and what it costs — it is a whole agent run.
- **Clicking a finding doesn't highlight or scroll to its lines** yet.
- **Findings' line numbers are as of the review**, but a file that changes loses its review
  outright (it is keyed by the whole file's hash), so they are never shown against moved lines.
- **Drift is not reviewed on its own.** A file changed outside a turn reads "not reviewed" until
  the next editing turn or **Review now** — by design, so opening a session costs nothing.
- **A review in flight is not cancelled** when its session is left; its result is dropped.

## Known gaps (the pivot away from review cycles)

- **A hand edit in the checkout shows in `/diff` at once, but the chunk list (and so the file
  reading "not reviewed") and clearing the notes on that file only happen on the next agent
  event** (a write, a tool call, a turn ending). Nothing watches the filesystem, deliberately: the agent is meant to make every
  edit, and OS change notifications are best-effort anyway.
- **Run the desktop app with `bun run desktop`** (from the repo root; it runs `tauri dev`).
  Its `beforeDevCommand`, `desktop/scripts/prepare-sidecar.mjs`, builds `dist/turnstile` and
  copies it to `binaries/` and ALSO over any existing `src-tauri/target/{debug,release}/turnstile`.
  That last copy is the one the app actually runs, and Tauri only refreshes it when Cargo
  rebuilds, which is how the app used to keep running an old sidecar. Every copy removes the
  destination first (`freshCopy`): overwriting a signed binary's inode in place gets the new one
  SIGKILLed by macOS on launch. The bundled `claude` under `target/*/resources/claude-cli/` gets the
  same treatment, because Tauri copies resources in place (unlike the sidecar), and a restart while
  the old sidecar's `claude` still ran from that copy made every resume die with SIGKILL. That
  restart used to leave the old sidecar running, too: `tauri dev` kills the app outright, so
  `RunEvent::Exit` never fires. `sidecar.rs` sets `TURNSTILE_EXIT_WITH_PARENT=1`, and
  `cli/parentWatch.ts` then shuts the sidecar (and its `claude`) down once it is reparented. The script prints the build's hash and commit (with "+
  uncommitted changes" when dirty), so you can see which version is starting.
- **A HEAD-tree file explorer** — showing the repository's files before a session opens — was
  prototyped separately and is not in this repository; the explorer here falls back to the
  opened folder instead.
