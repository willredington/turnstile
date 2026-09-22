# Highlight to Ask — as built

> **Status: implemented.** This file described a plan; it now describes what shipped, so that a
> reader who finds it does not build the version that was designed and then reconsidered.

**What it is:** highlight some code and ask a question about it, and get an answer now. The gutter
drag already produced a **note** (`Session.annotate`), which is deferred by design and delivered to
the agent by `sendNotes` to act on — that covers "highlight and ask for an edit". This is the other
half: asking *what this does* or *why it is like this*, without queueing work, without changing
anything, and without waiting for the agent to be free.

**Architecture:** an `Asker` port answering one question about one line range, backed by its own
OpenRouter model and given the same `RepoReader` the reviewer gets so it can look around. Building
the payload is pure (`core/ask.ts`). The answer lands in a card set into the document, and is
deliberately **not** written into the transcript or anywhere else.

## What changed from the original plan

Three decisions were settled with the user before building, and two of them reversed this document.
They are recorded here because the reasoning is not recoverable from the code.

| | Planned | Built | Why |
|---|---|---|---|
| Where the answer goes | A side panel or popover — "Task 5 picks one" | Inline, as a block widget in the document | Asked for directly: it should look near-identical to the highlight/annotation styling that already exists. It is the same gesture on the same lines, so it should read as the same family of card. |
| How you start one | Gutter drag only — a text-selection affordance was explicitly ruled out | Selecting the code, plus the gutter drag | The ruling-out was wrong, and it took a round trip to find out. "Highlight and ask" means selecting the code to most people, and shipping only the gutter route meant the feature read as missing to the person who asked for it. |
| Steps to ask | One composer for every case | A pill on the board, a question box straight away everywhere else | Where a selection can only become a question, the step that chooses a verb decides nothing. |
| Follow-ups | Explicit non-goal: "one selection, one question, one answer" | Threaded | Questions rarely land on the first try. The cost turned out to be small because the server stays stateless — a follow-up sends the thread back with it. |
| Where the answer lives | Not persisted | Not persisted (unchanged) | An answer is not a note. Notes are the thing that survives, reaches the agent and becomes work; blurring the two would make the board's record of what was asked for mean less. |

One more, not in the original: **`Session` was not touched.** The plan had `Session.ask()`; the built
version routes `/ask` past the session entirely, to `serveApp`'s own `asker` dep. Asking runs no
turn, writes nothing and mutates no session state, so going through the session would have bought
nothing — and it is what makes "ask while the agent is mid-turn" true by construction rather than by
careful handling.

## What is where

| Piece | File |
|---|---|
| The payload, bounded and pure | `src/core/ask.ts` |
| Line numbering, shared with the reviewer | `src/core/numbering.ts` |
| The port | `src/core/ports.ts` (`Asker`, `AskRequest`) |
| Its own model config | `src/core/config.ts` (`ask`), defaulting to Haiku |
| The agent | `src/adapters/model/asker.ts`, prompt in `prompts.ts` (`ASK_SYSTEM_PROMPT`) |
| Its tools — read-only, shared with the reviewer | `src/adapters/model/tools.ts` |
| The route | `src/adapters/web/server.ts` (`POST /ask`) |
| The threads, per tab, page-lifetime | `src/adapters/web/ui/editor/askMemory.ts` |
| The hook both surfaces use | `src/adapters/web/ui/editor/useAsk.ts` |
| The card | `src/adapters/web/ui/editor/AskThread.tsx` |
| The gestures | `src/adapters/web/ui/editor/selectionAsk.ts` (cursor selection), `lineDrag.ts` (gutter), `parts.tsx`'s `Composer` and `SelectionAsk` |

## Constraints it holds to

- **The agent does not answer.** It cannot answer while it is mid-turn — which is exactly when you
  are reading its output and want to ask — and the question is not the work, so it should not cost
  the agent's context window.
- **Asking changes nothing.** No file is written, no note is stored, no turn is run. It is a read.
- **Read-only by construction**, not by deny-list: the asker is given `read_file`/`glob`/`grep` and
  there is no write tool to withhold.
- **A missing `OPENROUTER_API_KEY` says so** on the card, keeps the question, and offers to send it
  again. It never becomes a spinner that does not stop.

## Verified live

Against a real model (`anthropic/claude-haiku-4.5`, which resolves on OpenRouter — the default is
good): a range question answered in ~5s using `grep` and `read_file` and citing real files and
lines; a follow-up of just "Why?" answered correctly from the thread it was given; a whole-file
question; and a missing key answered as a 409 the card renders, not a hang.

One thing that only showed up live: the model narrated ("Perfect. Now I have the answer. Let me
verify…") above its real answer. Fixed in two places — the prompt forbids narration, and the
adapter takes the last step's text rather than the aggregate, since chatter emitted alongside a
tool call can otherwise land in it.

## Still open

- **Whether the question box takes the cursor is unverified.** The focus call lands; whether it
  survives could only be tested in a backgrounded automation tab, where frames are suspended and
  focus does not behave like a real window. Seven approaches were tried; the one that shipped
  hands focus over while handling the event that raised the selection, which is the only point
  early enough to beat CodeMirror's own focus restoration.
- **No escalation path.** Deciding an answer should become work means writing a note by hand. A
  "turn this into a note" button is the obvious next thing and was left out of v1.
- **A question is anchored to line numbers, not to content.** Unlike a note, which carries
  `lineText` and retires itself when the file changes underneath it, a thread keeps pointing at
  whatever those line numbers now hold. It is page-lifetime state, so the window is small, but it
  is a real difference from how notes behave.
