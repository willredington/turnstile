# Turnstile

A review companion for a coding agent. It fights **human cognitive drift**: the slide into
rubber-stamping an agent's changes without actually processing them.

Turnstile *is* the client the agent talks to. It drives Claude Code directly through the
Claude Agent SDK (no separate proxy process in between), runs it right in your checkout, and
shows you everything that session has changed since it started, as it happens,
each changed file reviewed against your repository's own rules. You read the diff, leave notes on the lines that matter,
and send those notes to the agent when you're ready. Nothing blocks: the agent is never held
waiting for an approval.

> Turnstile began as a blocking review gate: after every turn the agent waited until you
> approved or sent back each change. That design was replaced by the one described here.

## The premise that must not break

Putting an AI summary between you and the code is the same mechanism that *causes* drift.
Turnstile avoids that by keeping the model's output narrow and the reading yours:

1. **The model flags problems, not a verdict.** Each changed file gets a list of findings —
   usually empty — each one a rule the change breaks, where it breaks it, and how badly. The
   model writes none of it: it answers every rule true or false, and the rule's own
   description says what is wrong. Never a summary of what the change does.
2. **You read the file, not a digest of it.** A changed file opens as the whole file, top to
   bottom, with its changes marked where they fall. Findings sit beside the code; they never
   replace it.

If you find yourself skimming the findings instead of the diff, that is the signal the tool
exists to catch — not friction to design away.

## Requirements

These steps assume macOS.

- **Bun 1.3+**: builds Turnstile and runs it from source.
- **Node.js and npm**: run the desktop app's Tauri tooling.
- **Rust**, via rustup, plus the Xcode Command Line Tools. Tauri compiles the desktop shell with them.
- **Claude Code, logged in.** Turnstile drives Claude Code through the Claude Agent SDK, which
  spawns the `claude` CLI itself. The CLI authenticates however it normally does: its own login,
  or `ANTHROPIC_API_KEY` in the environment. Turnstile does not manage that.
- **An OpenRouter API key.** The review and the answers to your questions both use it (see "The
  review" and "Asking about code" below). The models you pick must support tool calling.
- **A git repository to work in.** If the folder you pick isn't one, Turnstile offers to create it.

## Setup

### 1. Install the toolchain

```bash
xcode-select --install                                   # skip if already installed
brew install oven-sh/bun/bun node                        # Bun and Node/npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
npm install -g @anthropic-ai/claude-code && claude       # log in to Claude Code once, then exit
```

### 2. Set your OpenRouter API key

Create a key at <https://openrouter.ai/keys>, then export it from your shell profile so every
terminal has it, including the one you launch the desktop app from:

```bash
echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.zshrc
source ~/.zshrc
```

Turnstile reads the key only from the environment, never from a config file. The key is checked
per request, so a missing one doesn't stop the app from starting. Each review and each question
fails with an error on screen instead. To use a variable with a different name, set
`openrouter.apiKeyEnv` in config.

### 3. Write your user-level config

A personal config at `~/.turnstile/config.json` applies to every repository you open. A repo's
own `.turnstile/config.json`, if it has one, overrides it field by field (see "Two config
locations" below).

```bash
mkdir -p ~/.turnstile
cat > ~/.turnstile/config.json <<'EOF'
{
  "model": { "models": ["anthropic/claude-opus-5"], "temperature": 0 },
  "ask": { "model": { "models": ["anthropic/claude-haiku-4.5"], "temperature": 0 } },
  "openrouter": { "apiKeyEnv": "OPENROUTER_API_KEY" }
}
EOF
```

Any field you leave out takes its default. "Configuration" below lists every field. Turnstile
**won't start** if this file isn't valid JSON or has a bad value, so a typo shows up right away
instead of being ignored.

### 4. Add at least one rule

The review checks each changed file against your rules, and **a file that no rule covers is
never reviewed**. Rules live outside the checkout, in
`~/.turnstile/rules/<repository path with / and . turned into ->/`, one YAML file per rule. For
a repo at `/Users/me/projects/my-app`:

```bash
mkdir -p ~/.turnstile/rules/-Users-me-projects-my-app
```

Turnstile prints the exact directory when it starts. "Rules" below covers the format.

### 5. Install dependencies and run the desktop app

```bash
git clone https://github.com/willredington/turnstile.git
cd turnstile
bun install             # the app's own dependencies, needed to build the sidecar

cd desktop
npm install             # Tauri CLI and plugins
npm run tauri dev       # builds dist/turnstile, compiles the Tauri shell, opens the window
```

The first `tauri dev` compiles the Rust side and takes a few minutes. Later runs are quicker.
Each run rebuilds the `turnstile` binary first (`scripts/prepare-sidecar.mjs`), so the window
always runs your current source. It prints the build's hash and commit as it starts. When the
window opens, pick the repository you want to work in. To switch repositories later, use
**File → Open Folder…** (⌘O).

Launch it **from a terminal that has `OPENROUTER_API_KEY` set**. The app hands its environment
down to Turnstile, so a key exported only in some other shell won't reach it.

### Without the desktop app

Turnstile also runs as a CLI that serves the same UI in a browser tab:

```bash
bun link                 # from the repo root: puts `turnstile` on your PATH
cd /your/project
turnstile                # serves the UI and opens a browser tab
```

`turnstile init` writes a repo-level `.turnstile/config.json`, if a project needs settings of its
own. `TURNSTILE_NO_BROWSER=1` stops the tab from opening; the URL is printed either way.
`TURNSTILE_CLAUDE_CODE_EXECUTABLE` tells Turnstile which `claude` binary to spawn, for the rare
case where the SDK can't find one on its own.

## How a session goes

```
you type a message
  │
  ├─ first message of a session: your checkout's tree, uncommitted work included, is
  │  recorded as the session's baseline — before the agent can touch anything
  ├─ the agent works in your checkout
  ├─ every edit lands in the changed-files list immediately (read from git, no model)
  │    ...and starts that file's review in the background
  └─ the turn ends; the agent is free for your next message
```

Along the way, or afterwards:

- open any changed file to read it whole, with its changes and the review's findings marked;
- drag across any line — changed or not — to leave a note;
- click **Send N notes** when you want the agent to act on them, with or without a message
  of your own.

**Nothing is ever reverted, and nothing is ever waited on.** The agent keeps working; your notes
reach it when you send them.

## The baseline, and what's on the list

The agent works directly in your checkout, in the directory you launched Turnstile from. When a
session sends its first message, the checkout's tree as it stands — committed, uncommitted and
untracked files alike — is recorded in git as `refs/turnstile/baselines/<session>`, through a
scratch index that never touches yours. That is the **baseline**.

The changed-files list is simply every file in the checkout that differs from the baseline:

- **committed or not** — both sides are compared as trees, so the agent committing its own
  work never hides it;
- **whoever made it** — the agent's write tool, a shell command, or you editing a file by hand;
- **for the whole session** — the list is cumulative. Resume a session tomorrow, or restart the
  app, and you see everything that has changed since it began, with your notes still attached.

Work you already had in progress when the session started is part of the baseline, so it is
never on the list. The baseline lives in git, not in Turnstile's own state, so there is nothing
to lose or go stale. Turnstile creates no branches and never commits to yours — what happens to
the agent's work is your call, with ordinary git.

Versions before this one ran every session in its own worktree under `.turnstile/worktrees/` on
a `turnstile/<session>` branch. Those are left alone; remove them with `git worktree remove`
and `git branch -D` once you've taken whatever you want from them.

### Marking a file reviewed

Once you've read a changed file, **Mark reviewed** in its header (or the ✓ on its row) moves it into
the folded **reviewed** section at the bottom of the rail, so the rest of the list shows only
what you haven't read yet. If it's open it stays open, and its tab's dot turns green. It stays
there until the file changes again, and then it comes back by itself: new work on a file is never
something you've already read. To bring one back sooner, press
the ↩ beside its row there, or **Unmark reviewed** in its header. Opening a reviewed file — from
the **reviewed** section, the project tree, anywhere — only reads it: the mark is your record of
what you've read, and looking again is not a reason to lose it. What you've reviewed is kept per
session and survives restarts, the same way notes are. A hand edit brings a reviewed file back
on the agent's next action, not straight away.

### Sessions

The **Sessions** menu in the top bar starts a fresh conversation or resumes any past one without
restarting the app. A new session's baseline isn't recorded until you send its first message, so
starting one and never using it leaves nothing behind. Only conversations Turnstile started are
listed — a plain `claude` session run in the same directory has no baseline to measure from.

## Notes

A note is anchored to a file and a line range, and quotes the lines as they read when you wrote
it, so the agent knows which version of the code you were looking at. Notes are kept per
session and survive restarts.

A note is about the file as it stood when you wrote it, so **any change to that file clears
every note on it**, sent or not — a note left pointing at a line it is no longer about is worse
than none. Notes on other files are untouched.

A note goes to the agent **only when you send it** — from the file pane, or from the compose box
in the conversation, where you can add a message of your own. An ordinary message never carries
notes along. Sent notes stay visible, marked as sent, and the conversation shows them with the
message that carried them.

Notes on a file that is no longer changed (the agent reverted it, say) collect in their own
section of the sidebar, so none go missing.

You can also talk to the agent while it is still mid-turn. A message typed then does not
interrupt it — interrupting is how you get half-finished work — it queues, and goes as the next
turn once this one ends. Sending notes mid-turn works the same way.

## Asking about code

A note asks for a change. The other half of reading someone else's work is wanting to know what
something *does*, or why it is the way it is — and wanting to know now, usually while the agent
is mid-turn and in no position to answer.

Select some code and ask. The answer arrives as a card set into the file under those lines, and
you can keep asking follow-ups in it.

- **On a changed file**, a small **Ask** appears beside the selection. It opens the same box a
  gutter drag opens, because there a selection can become either a note or a question.
- **On any other file** — anything you opened from the project tree — a question box opens
  straight away, since asking is the only thing a selection can become there. Enter asks,
  Escape dismisses.
- **Dragging the line numbers** works too, and now offers **Ask** beside **Leave note**.
- **"Ask about this file"** in the file pane's header asks about the whole thing. That answer
  rides at the top of the document.

It works on any file, changed or not. Half the questions worth asking are about code nobody
touched — and an unchanged file has no review on it to read, so a question is often the only way
in.

Three things it deliberately does not do:

- **The agent does not answer.** It cannot answer while it is mid-turn, which is exactly when
  you want to ask, and your question is not the work — it should not spend the agent's context
  window. A separate, cheaper model answers, configured under `ask` (see Configuration).
- **Nothing changes.** No file is written, no note is stored, no turn is run. The answering
  model is given read-only tools and there is no write tool for it to reach for.
- **Nothing is kept.** Answers are not notes. They survive switching tabs and are gone when you
  close the page. If an answer is worth keeping or acting on, write it as a note — that is the
  thing that persists and reaches the agent.

Without an API key, asking says so on the card rather than hanging.

## Tool permissions

The agent's native `Edit`/`Write` tools are disallowed; Turnstile's own write tool is the only
way a file's contents change, and it only writes inside the repository.

Everything that isn't a file write — a shell command, an MCP tool call — auto-approves by
default; asking you to click "Allow" on every `git status` would just retrain you to
rubber-stamp permission prompts, which is the exact drift this tool exists to fight. Only two
things still stop for a yes/no prompt: `sudo`, denied unconditionally, and whatever you name in
config:

```json
{
  "toolPermissions": {
    "denyPatterns": ["rm -rf", "^mcp__some-server__"]
  }
}
```

Each pattern is a regular expression. For a `Bash` call it matches the full command text — so
`rm -rf` denies only that shape of command — and for every other tool it matches the tool name,
so `^mcp__some-server__` denies a whole MCP server by name.

## Plan mode

Plan mode is available from the compose box: the agent can only read and plan until you answer
the plan it submits.

While it is on, anything that does more than read stops for you — not just file writes through
Turnstile's own tool, but shell commands too. Exploring stays silent (`ls`, `cat`, `rg`,
`git log`, `git diff`, `find`, `sed -n`), and anything else — a redirect, `sed -i`, an install,
a script, a subagent — asks first, saying plan mode is why. Allowing one does not turn plan mode
off.

The agent's own plan file is the exception, and it is not a hole: it writes that through a tool
of Turnstile's own, which can only ever write one markdown file into Claude Code's plan
directory — never into your project. So planning costs you no prompts at all.

This is stricter than the rest of Turnstile on purpose. Everywhere else, tool calls auto-approve
unless you name them in `denyPatterns`, because a prompt for every `git status` just teaches you
to click through. Plan mode has no review behind it to catch what slipped past, so the bias flips
for as long as it is on.

A submitted plan arrives **pinned at the top of the review rail**, rendered as the document it is —
headings, steps and prose, not its own markdown source. It is the one surface that does not let
you walk away without answering, because the agent is genuinely stopped until you do. Three ways
out:

- **Approve it.** The agent leaves plan mode and starts work.
- **Send it back.** Say what is wrong and the agent revises and submits again.
- **Note the parts you disagree with, then send it back.** **Highlight** the words you object to,
  or **drag the margin** beside a block — both leave a note anchored to that part of the plan, as
  many as you like. They go back together as the reason, with an optional message on top.
  Approving is refused while a note is outstanding — a note is a disagreement, and approving over
  one would throw it away and tell the agent the plan was fine.

A note is recorded against the plan's *source* lines even though you are reading the rendering,
because the agent wrote the plan as text and is about to revise it as text: "lines 13-14" is
something it can find again.

Once you answer it, the plan moves into the conversation — folded, labelled by what you decided,
and still there when you resume the session later. The pinned entry is for deciding; the record is what
you go back to.

**A plan nobody answered comes back as a plan.** If the session ended while one was on the
table, resuming brings it up again as a decision rather than as history — because it still is
one. The agent is no longer sitting inside that call, so your answer reaches it as its next
instruction instead; everything you do with the plan is otherwise identical.

The plan stays pinned while you read the code it is about, which is usually the only way
to tell whether it is any good. Notes on a plan are not notes on a file: they live only as long
as the round, go back as the plan's verdict rather than as a later message, and are never
written to `.turnstile/annotations.json`.

## The review

A model reviews each changed file, shortly after every edit, against **the rules your
repository writes down**. It is a small agent, not a single prompt: it sees the file's diff, the
whole file with line numbers, the rules that govern that file, and the repository's
`CLAUDE.md`/`AGENTS.md`. It can also read, list and search the rest of the repository
(read-only, never outside the repository), because whether a change keeps a rule often turns on
something outside the changed lines: a caller the change broke, the test a rule asks for, the
sibling a rule says to follow.

Its answer is typed. For **every** rule that governs the file it returns exactly one verdict:

- **Broken or kept**, true or false.
- **How badly**, `low`, `medium` or `high`, unless the rule fixes its own severity.
- **Where**: the lines that break it, in this file or any other.

It writes no prose. A finding is the rule's name, its `description` as the message, the
severity, and where. A submission that skips a rule, answers one twice, or names a rule that
does not govern the file is refused, and handed back to the reviewer to fix within the same run.
A problem no rule describes is not reported. Rules are the whole mechanism, so anything you want
caught — security, data loss, a broken build — is written as a rule.

Kept is the expected verdict for most rules on most changes: it is told a rule is broken only by
what the change introduces, never by what the file already did, and not because the code could
be stricter or cleaner. A file no rule governs is never sent to the model at all.

A finding shows on the change whose lines it overlaps, and a change is as serious as its worst
finding. Findings outside every change (unchanged code the change affects, or another file it
breaks) show at the top of the file. The review rail down the left groups the changed files by their
worst finding — high, med, not reviewed yet, low, none, skipped — most serious first; the quiet
groups start folded.

Opening a file from the rail — or from the project tree — puts it in the **tab strip** across the
top, and it stays there until you close it. Everything you open gets a tab, changed or not,
reviewed or not, and each one carries the same coloured dot the project tree gives it: its risk
group, green once you've marked it reviewed, and no dot at all for a file the agent never touched.
Closing a tab means "not now" — a changed file keeps its row in the rail either way.

### Rules

The review is an independent check on the coding agent, so **rules live outside the checkout**,
where the agent won't come across them:

```
~/.turnstile/rules/<repository path, with / and . turned into ->/
# e.g. ~/.turnstile/rules/-Users-me-projects-my-app/
```

Turnstile prints the directory when it starts. To share rules across a team, point
`review.rulesDir` in config at a checkout of a separate rules repository, using an absolute path
or `~/…`.

The coding agent is kept out of `~/.turnstile`, the checkout's own `.turnstile/` and any
configured `rulesDir`, by any means. Tested live, against an agent told to try every route it
could:
- **Claude Code's own file tools** (Read, Grep, Glob) are blocked by permission deny rules.
- **Every Bash command** runs in Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on
  Linux), which denies reading or writing those directories. `cat`, `grep -r` from a parent,
  and `python`/`node` file reads all fail with "Operation not permitted", however the command is
  phrased.
- **Anything else that names those paths**, including Turnstile's own write tool, is refused
  outright.

The sandbox takes away only those directories. The agent can still write anywhere else, and
network access works: each new host goes through Turnstile's usual permission handling. If a
command asks to run outside the sandbox, you are asked first. On Linux without bubblewrap the
sandbox can't start, and only the deny rules and path check apply.

**Keep rules out of git history, too.** A repo whose history ever contained a rules file will
give it back through `git show`. Rules left in an old `.turnstile/rules/` inside the checkout are ignored, with a
warning at startup.

A rule is one YAML file in that directory (nested folders are fine; `.yml` works too). The
file's name is the rule's name:

```yaml
# validate-request-bodies.yaml
description: Request bodies are parsed with parseBody
globs: src/handlers/**/*.ts
severity: high
rule: |
  A handler that accepts a request body takes it as `unknown` and checks it with `parseBody`
  from `src/lib/validate.ts` before reading any field. See `createUser` in
  `src/handlers/users.ts` for the pattern.
violates: Reading a field off a body that has not been through `parseBody`, typing the body
  parameter as anything but `unknown`, or casting it (`body as Foo`).
complies: The body is typed `unknown` and passed through `parseBody` before any field is read,
  or the handler takes no body.
```

| Field | | |
| --- | --- | --- |
| `description` | required | One line: what the rule asks for. It is also the finding's message. |
| `rule` | required | The rule itself. |
| `globs` | optional | Which files it governs: one glob or a list. Leave it out to govern every file. |
| `severity` | optional | `low`, `medium` or `high`. Leave it out and each violation's severity is judged. |
| `violates` | optional | What counts as breaking it. |
| `complies` | optional | What counts as keeping it, including the cases where it doesn't apply. |

A rule can also be about everything a change touches, not just the lines it changed. This one
has no `globs`, so it governs every file, and no `severity`, so the reviewer judges how bad each
violation is. It is the rule to write if you want a broken caller caught, since the review
reports nothing no rule describes:

```yaml
# callers-still-fit.yaml
description: Changing an export keeps every use of it working
rule: |
  When a change alters anything exported — a function's parameters or return type, a type's
  fields, a constant's value, a rename or a removal — every place in the repository that uses
  it, tests included, still fits the new version.
violates: A call site, import or test that no longer matches what the change made of the
  export — a missing or wrong argument, a field that is gone, a return value used in the old
  shape, an import of a name that no longer exists.
complies: The change alters nothing exported, or every use of what it altered was updated to
  match, in this change.
```

A violation here is found in the caller, not in the changed file, and the finding points there.

- **Say what a violation looks like.** `violates` and `complies` are the most effective thing to
  add to a rule that misfires.
- **Point at examples.** The reviewer can read the repository, so "see `users.ts` for the
  pattern" works, and so does a rule about other files ("every handler has a test in `tests/`").
- **Unknown keys are errors**, so a misspelled `severtiy` does not silently do nothing. A rule
  file that doesn't parse or validate is skipped with a warning naming the problem, and every
  other rule still runs. Markdown rules from before this format are skipped the same way, with a
  warning to convert them.

`CLAUDE.md` and `AGENTS.md` files are picked up with no setup: the repository root's, plus the
ones in each directory above the changed file. They are background for judging the rules —
written for the coder, they say what is normal here — and never rules themselves.

Rules are read fresh on every pass. Editing one re-reviews exactly the files it governs, and
nothing else.

### What isn't worth a model call

These are listed and diffed like anything else, but never sent to the review. Each shows the
reason instead:

- documentation and prose (`.md`, `docs/`, `LICENSE`, `CHANGELOG`, …)
- whitespace and formatting, and comment-only edits
- mechanical (100%-similarity) renames
- generated and vendored paths: lockfiles, `node_modules/`, `vendor/`, `dist/`, `.next/`, `*.snap`

Indentation-significant languages get stricter treatment — reindenting Python or YAML is a
behavior change made entirely of whitespace, so it is checked.

```json
{
  "riskBar": {
    "alwaysReview": ["migrations/**", "src/auth/**"],
    "neverReview": ["generated/**"],
    "specPaths": ["docs/plans/**", "*.plan.md"]
  }
}
```

`alwaysReview` forces a review and outranks everything. `neverReview` extends the built-in
skip list rather than replacing it. `specPaths` names plan or spec documents that the
documentation rule would otherwise skip.

### Files, chunks and the cache

A change is cut into **chunks**: runs of hunks from one file, coalesced when they sit within a
few lines of each other and split past a line budget. Chunks are what the board shows. The
review, though, reads a whole **file** at a time, and is cached under everything it was a
function of:
- the file's content,
- its chunks,
- every field of the rules, and the context docs, it was reviewed against.

A file nobody touched again, under rules nobody edited, is never reviewed twice, and reverting
to an earlier state is a free cache hit. A chunk past the analysis budget, or a binary file, is
shown in full but not sent to a model, and says so.

## The diff

Rendered from a parsed patch, not dumped as `git diff` output. Nothing is ever truncated,
placeholdered or dropped — presentation may fold long runs of unchanged lines, never a change.
Each line carries its own number (the old one for a removed line), what was removed stays struck through where it
was, and each change is announced by a card carrying its findings.

## The file explorer

A panel down the left browses the whole project, not just what changed (a dot marks each
changed file), and opens any file read-only. It shows the repository once a session has opened,
and the directory Turnstile was started in before that. It walks the tree the way git does (`.gitignore`
respected, `.git` excluded at every depth, symlinks never followed), and every requested path
is re-resolved against the root before anything is read.

## Snapshots

The checkout is captured through a scratch index, never through its own:

```
GIT_INDEX_FILE=$GIT_DIR/turnstile/index-<pid>-<uuid> git read-tree HEAD
GIT_INDEX_FILE=$GIT_DIR/turnstile/index-<pid>-<uuid> git add -A
GIT_INDEX_FILE=$GIT_DIR/turnstile/index-<pid>-<uuid> git write-tree
```

Reading the tree never touches the index, HEAD, stash, reflog or history. Untracked build output
is kept out by `untrackedExcludes` (`target/`, `node_modules/`, `dist/`, … by default), so an
agent that builds a project before anyone has written a `.gitignore` doesn't flood the list.

## Commands

| Command | What it does |
|---|---|
| `turnstile` | Open the app. This is the normal way to use Turnstile. |
| `turnstile init` | Write `.turnstile/config.json` and gitignore it. |
| `turnstile reset` | Forget every note and reviewed mark in this repo. |

## Configuration

```json
{
  "model": { "models": ["anthropic/claude-opus-5"], "temperature": 0 },
  "review": { "maxSteps": 16, "concurrency": 3, "timeoutMs": 90000, "rulesDir": "~/team-rules/my-app" },
  "ask": {
    "model": { "models": ["anthropic/claude-haiku-4.5"], "temperature": 0 },
    "maxSteps": 6,
    "timeoutMs": 60000
  },
  "riskBar": { "alwaysReview": [], "neverReview": [], "specPaths": [] },
  "toolPermissions": { "denyPatterns": [] },
  "untrackedExcludes": ["target/", "node_modules/", "dist/", "build/", ".venv/", "__pycache__/"],
  "openrouter": { "apiKeyEnv": "OPENROUTER_API_KEY" },
  "telemetry": { "enabled": false, "endpoint": "http://127.0.0.1:4318" }
}
```

`models` is a priority-ordered fallback list for the review; you are billed for whichever
actually serves, and each must support tool calling. `temperature` defaults to 0, so the same
change should get the same verdicts.

`review` bounds each file's review:
- `maxSteps`: tool-using steps before it must submit its verdicts.
- `concurrency`: files reviewed at once.
- `timeoutMs`: one file's whole budget.
- `rulesDir`: where the rules are, if not the default under `~/.turnstile/rules/`.

`ask` is the same shape, for answering a question about a selection (see "Asking about code").
It has its own model on purpose: a review runs unattended on every changed file and is worth a
capable model, while a question is asked by someone watching a spinner and wants a fast, cheap
one. It defaults to Haiku; set `ask.model.models` to change it, and it must support tool calling.
- `maxSteps`: tool-using steps before it must answer with what it has.
- `timeoutMs`: one question's whole budget, tool calls included. Shorter than a review's —
  someone is waiting. Both attempts of a retried question share it, so a failure that is going
  to be reported is reported inside this budget rather than twice it.

Both models authenticate with the same OpenRouter key.

### Telemetry

Off by default. Turned on, Turnstile exports OpenTelemetry over OTLP/HTTP to `endpoint`:

```json
{ "telemetry": { "enabled": true, "endpoint": "http://127.0.0.1:4318" } }
```

To look at it, start the bundled backend (`telemetry/compose.yaml` — Grafana's all-in-one OTLP
stack, which needs no configuration):

```bash
bun run telemetry          # start it
bun run telemetry:stop     # stop it
bun run telemetry:logs     # follow its logs
```

Grafana is then on http://localhost:3000 (admin/admin), with traces in Tempo, metrics in
Prometheus and logs in Loki. **Dashboards → Turnstile** puts it together, per session or across
all of them: the agent's cost, tokens and events, review and question outcomes, keystroke latency,
and tables of failed model runs and recent turns that open straight into their traces. It is
provisioned from `telemetry/grafana/turnstile-dashboard.json`; edits in the UI are allowed but not
saved back, so export over that file to keep one. History lives in a named volume, so it survives a restart;
`docker compose -f telemetry/compose.yaml down -v` is what throws it away. Turn telemetry on, run a session, and **Explore → Tempo → search by
service** shows both `turnstile` and `claude-code`; filtering a trace on `session.id` puts the
review that ran next to the turn that caused it.

Queries worth having, all verified against a real session:

```promql
sum(claude_code_cost_usage_USD_total)                      # what the agent has cost
sum by (type) (claude_code_token_usage_tokens_total)       # input/output/cacheRead/cacheCreation
sum by (outcome) (turnstile_review_files_total)            # reviewed vs cached vs failed vs skipped vs unruled
sum by (severity) (turnstile_findings_total)               # what the reviewer is finding
sum by (actor, outcome) (turnstile_files_saved_total)      # your saves vs the agent's
turnstile_editor_keystroke_latency_sum
  / turnstile_editor_keystroke_latency_count               # mean keystroke cost, ms
```

Two things export, and they meet in the backend rather than in Turnstile:

- **Turnstile**, as `service.name=turnstile`. Spans for the review pass
  (`turnstile.review.run` with a `turnstile.review.file` per model call), and for
  `turnstile.diff`, and `turnstile.ask` per question. Under each model call, the AI SDK's own
  spans for the run, each step, each model request and each tool call — model, finish reason,
  tokens and tool names, never the prompt or reply — which is where to look when a review fails
  or a question comes back unanswered. Counters for `turnstile.review.files` (by outcome: reviewed, cached, failed,
  skipped, or unruled — no rule governs it), `turnstile.findings` (by severity), `turnstile.files.saved` (by actor — yours or
  the agent's — and outcome) and `turnstile.notes.sent`. Histograms for
  `turnstile.editor.build` and `turnstile.editor.keystroke.latency`, measured in the browser
  where the keystroke actually lands and batched to the server.
- **The agent**, as `service.name=claude-code`. The Claude Code CLI is instrumented already, so
  its per-turn spans, model requests, tool calls, tokens and cost come from setting its
  environment rather than from any code here. `"agent": false` leaves it alone.

Both stamp `session.id`, which is what joins them: filter on it to see the review that ran
alongside a turn. They are correlated rather than nested, because the agent SDK opens one
long-lived connection per session — nesting would hang every turn of a multi-hour session off a
single span.

Turnstile asks the agent CLI for **cumulative** metrics
(`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`). Without that, Prometheus's OTLP ingest
accepts the agent's metrics and then discards them — cost and tokens included — while Turnstile's
own land normally. It is set for you; the note is here because the symptom (half the metrics
missing, no error anywhere) is otherwise very hard to place.

Other fields: `serviceName` (default `turnstile`), `traces` and `metrics` to disable a signal,
`headers` (`key=value,key=value`) for a collector wanting an `Authorization` header, and
`diagnostics` to report export failures instead of dropping telemetry silently — worth turning
on the first time you point at a new collector.

**Nothing you write or say is exported.** Durations, counts, file paths on review spans, model
and tool names. Not prompts, not file contents, not API bodies. Claude Code can export those
through four `OTEL_LOG_*` variables; Turnstile never sets them, so enabling them is something
you do deliberately in your own shell.

A collector that is down costs the measurements and nothing else: flushes are time-bounded, so
a stale `endpoint` cannot delay a session or stop the process exiting.

### Two config locations

`.turnstile/config.json` in the repo is read, and so is a personal `~/.turnstile/config.json` for
defaults you want everywhere. Where both exist, a field the repo sets overrides your personal
one, while a field only your personal config sets still applies. Arrays are replaced wholesale
by whichever file sets them, never concatenated. `turnstile init` only writes the repo-level
file.

## Failure behavior

| Situation | Behavior |
|---|---|
| Not a git repository | No session opens; the app offers to initialize the repository |
| Model outage during a review | The change stays on the list, marked "review failed" with the error, and the next change retries it. A change that already had a review keeps showing it |
| A rule file is malformed | Frontmatter it doesn't understand is ignored, and the file still applies as a rule |
| Malformed `.turnstile/config.json` | **Won't start** — a config that throws is safer than one that silently falls back to defaults you didn't choose |
| Agent process fails to spawn | Surfaced as a visible error in the conversation, not a silent hang |

## Architecture

Ports and adapters, in a strict downward stack:

```
core/       domain types, chunking, risk bar, notes, port interfaces
            zero I/O — no filesystem, no network, no process
   ↑
app/        session.ts, board.ts, review.ts — the pipeline, against ports only
   ↑
adapters/   agent-sdk · git · model · web · fs — each may import core, never a sibling adapter
   ↑
cli/        composition root: builds the adapters, wires them into the session
```

The boundaries are enforced, not documented: `tests/architecture.test.ts` walks the real import
graph and fails the build on an illegal edge, naming it. The pipeline runs against fakes in
tests — no git, model or agent needed.

The UI is a real React app under `adapters/web/ui/`, bundled by Bun itself with no Vite and no
separate build step, and embedded into the binary by `bun build --compile`.

## Development

```bash
bun run typecheck && bun run lint && bun test
bun run build          # compiles to dist/turnstile with the UI embedded
bun src/cli/main.ts    # run from source, against the current directory
```

`bun run simulate` starts the real web server against a fake, hand-built session — fixed files,
a fixed diff, a fixed transcript — so you can iterate on the UI without an agent, git repo, or
model call.

For the real thing, run it against a scratch repository — the agent works directly in whatever
checkout Turnstile was launched in.

No network access or API key is required to run the test suite — model calls sit behind the
`Reviewer` port and are faked in tests. The reviewer agent itself is tested against the AI SDK's
mock model.

## Scope

**Out of scope by design:** reverting or rolling back changes, committing the agent's work for
you, and acting as the merge/CI gate. Turnstile helps you read a working session as it happens;
the merge gate is a separate, final backstop.
