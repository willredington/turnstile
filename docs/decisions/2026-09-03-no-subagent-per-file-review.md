# Decision: not adopting subagent-per-file review cycles

## Context

The proposal under discussion: instead of one coding agent handling a whole turn, the main
agent spawns a subagent per file it needs to touch, each working in its own isolated
worktree. Each subagent's edit goes through its own review cycle. If a subagent decides it
needs to touch a second file, it spawns a further subagent for that file (recursively, with
the originating subagent's context threaded in so the child knows *why* it's making its
change). When every spawned subagent resolves, a final step merges all the changes together.

The motivation was better review history: an isolated, focused review cycle per file, rather
than one turn's diff spanning everything the agent happened to touch.

## Decision

Not pursuing this. ISR stays single-agent, single-ACP-connection, single-working-tree per
session, exactly as it is today (`src/app/session.ts` owns one `AgentConnection`;
`src/adapters/git/*` snapshots one tree through a scratch index, never a separate worktree
per unit of work).

## Why

**It fights the snapshot model on purpose.** ISR's baseline/diff pipeline deliberately never
touches the user's own index/HEAD/stash and never opens a second worktree — base and next are
always two views of *one* tree (see `GIT_INDEX_FILE`-based scratch index in
`src/adapters/git/*`, and the architecture note in `CLAUDE.md`). Subagent-per-file with real
worktree isolation means N independent trees that have to be reconciled back into one before
the existing chunk/gate/ledger pipeline can even run — a merge step bolted in front of
machinery that already exists to solve the isolation problem within a single tree: chunk keys
hash *content*, not location, per file/hunk-cluster, so each file already has an independent,
cacheable review identity in the ledger without forking any processes.

**Rejection loops are not fundamentally broken by the split, but they are real plumbing
cost.** A per-file subagent's ACP connection could in principle stay alive for the whole turn
and be re-prompted on rejection the same way `gateAndRevise()` re-prompts the main agent
today. But `SessionState` currently assumes exactly one live connection; supporting many means
the board/gate has to know which connection owns which chunks and route a rejection to the
right one. Not impossible — just cost that buys back nothing the current model doesn't already
have.

**Cross-file fan-out has a coherence problem that context-threading doesn't fully solve.**
Threading a parent subagent's rationale into a spawned child's prompt handles the forward
direction — the child knows why it's making its change. It does not handle the backward
direction: if the parent's own chunk is later rejected and its approach changes, any child
already spawned off the parent's *pre-revision* reasoning is now orphaned, and nothing detects
or invalidates it automatically. Concrete example walked through during this discussion:

> "Add docker to this repo" → subagent A writes the Dockerfile, subagent B writes
> `.dockerignore`. Mid-review, feedback on A ("harden the base image, add CI to build it")
> spawns subagent C for the GitHub Actions workflow. Eventually A resolves, then B, then C.
> The dangerous case: while reviewing B, the human says "looks good, but use a hardened
> Dockerfile" — feedback that actually targets A, not B.

B cannot comply with that feedback — nothing about `.dockerignore` can "use a hardened base
image." Making this work needs three things the design doesn't have:

1. **Detection** — something has to notice feedback given while reviewing B actually targets
   A. That's a classifier on every piece of feedback, or the human manually redirecting
   themselves (which is the routing work the system was supposed to save them from doing).
2. **Liveness** — by the stated resolution order, A may already be resolved and its process
   torn down by the time this feedback arrives. Reopening it means either keeping every
   subagent alive for the life of the *whole* task (so "resolved" stops being a real
   checkpoint), or respawning A from reconstructed history and losing the conversational
   memory of why it made its original choice.
3. **Cascade** — once A is reopened and changes, C (spawned off A's pre-hardening reasoning)
   may now be stale too. Something needs a dependency graph over which files' subagents were
   informed by which other files, computed at runtime, to know to re-open C as well.

Cross-file feedback like this is not a rare edge case for this codebase — it's the typical
case for any coherent multi-file change, and ISR's own layering rules
(`core → app → adapters → cli`) force coupled multi-file edits routinely. Items 1–3 above are
therefore not optional hardening, they're most of the system. And building them means
reconstructing, in orchestration code, what a single shared agent conversation already
provides for free: one shared tree and one shared context that any correction can reach,
because there was never a file-ownership boundary to route around in the first place. This
project's most recent commits before this discussion
(`ed2a5d2`, `02e8b80`, `785e378`, `3dad4af`, `83321a4`) were all fixes for stale
board/review state across a single rejection-revision cycle on *one* connection; the
coordination layer this proposal needs would have to solve that same class of bug across N
independent connections instead.

## What the actual grievance turned out to be

Separately from the subagent idea, the concern driving it was narrowed down to latency: worry
that giving feedback on outstanding chunks A, B, and C during a review round would serialize —
wait on the agent between each decision — rather than feel immediate.

Checked against the current implementation and this is already how it works:

- Inside an open review round, `recordVerdict` (`src/app/session.ts:431-449`) is fully
  synchronous — it records the verdict and advances `activeChunk` to the next undecided one
  immediately, with no wait on the agent. A, B, and C can be decided back-to-back.
- Outside an open review, `settleNow` (`src/app/session.ts:475-513`) queues a rejection's
  feedback immediately and refreshes the board without blocking on the agent.
- Every rejection from one review round is folded into a single `rejectionReason(...)` block
  (`src/app/gate.ts:330-370`) and sent back to the agent as **one** re-prompt covering all
  rejected chunks, not a separate turn per chunk.

No code changed as a result of this — the existing behavior already satisfies the concern.

## What we'd do instead, if the isolated-per-file "feel" is wanted later

Group/label the review board and ledger by file (`ReviewRail`, `livechunks.ts`) rather than
forking agent processes. Chunk keys already give each file's hunks an independent, cacheable
review identity; the missing piece, if it's ever needed, is presentation, not orchestration.

## Status

Closed, no follow-up scheduled. Revisit only if a concrete pain point shows up beyond the
latency concern already resolved above.
