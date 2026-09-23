import { mkdir, writeFile as writeTextFile } from 'node:fs/promises'
import { isAbsolute, join as joinPath, relative } from 'node:path'
import {
  type CanUseTool,
  createSdkMcpServer,
  getSessionMessages,
  listSessions as listSdkSessions,
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { describePermissionRequest } from '../../core/permissionPrompt.ts'
import { planFileName } from '../../core/planFile.ts'
import type { AgentConnection, AgentConnectionFactory, AgentHistory } from '../../core/ports.ts'
import {
  compileDenyPatterns,
  isAutoApprovedTool,
  isReadOnlyCall,
  reservedPathIn,
} from '../../core/toolSafety.ts'
import type { AgentEvent, AgentQuestion, PlanModeStatus, SessionSummary } from '../../core/types.ts'
import { resolveExecutable } from './resolveExecutable.ts'

/**
 * Turnstile as a Claude Agent SDK consumer.
 *
 * Replaces the ACP adapter: Turnstile no longer spawns a separate ACP proxy — the SDK spawns
 * (and owns) the Claude Code CLI subprocess itself, and this module talks the SDK's streaming
 * message protocol directly. `Edit`/`Write` are disallowed unconditionally:
 * `mcp__turnstile__propose_edit` (built by `buildWriteTool` below) is the only way the agent
 * can touch a file. Deliberately dumb, same as the ACP client it replaces: it translates the
 * SDK's message stream into `AgentEvent`s and holds the connection; deciding anything (gating,
 * diffing) belongs to `app/`.
 */

/** Handed in by `app/session.ts` as the agent connection's `writeFile` callback — see
 *  `AgentConnectionFactory`'s doc comment on why this is injected rather than reached for. */
type WriteFile = Parameters<AgentConnectionFactory>[1]

/** Handed in by `app/session.ts` as the agent connection's `requestPlanApproval` callback —
 *  same indirection as `WriteFile`, for the SDK's built-in `ExitPlanMode` tool. */
type RequestPlanApproval = Parameters<AgentConnectionFactory>[2]

export type AgentSdkClientOptions = {
  cwd: string
  onEvent: (event: AgentEvent) => void
  writeFile: WriteFile
  requestPlanApproval: RequestPlanApproval
  /** Regex strings from `toolPermissions.denyPatterns` (see `core/toolSafety.ts`), compiled
   *  once via `compileDenyPatterns` before the connection opens. Defaults to no deny patterns
   *  beyond the built-in sudo floor. */
  denyPatterns?: string[]
  /**
   * Paths the agent is refused any tool call naming (`core/toolSafety.ts`'s `reservedPathIn`):
   * Turnstile's own state, which is not the agent's to read or change. Defaults to none.
   */
  reservedPaths?: string[]
  /**
   * Absolute directories the agent must not read or write by ANY means — Turnstile's state. Enforced two ways, both by Claude Code itself (see `protectionOptions`):
   * `Read(...)`/`Edit(...)` deny rules for its built-in file tools, and its OS sandbox
   * (`filesystem.denyRead`/`denyWrite`) for every Bash command, whatever the command's text.
   * Empty (the default) leaves the sandbox off entirely.
   */
  protectedDirs?: string[]
  /** Overridable so tests never spawn a real subprocess or hit a real model. Defaults to the
   *  real SDK's `query`. */
  queryFn?: typeof query
  /** Overridable so tests never touch a real `~/.claude/projects` directory. Defaults to the
   *  real SDK's `getSessionMessages`, used by `loadSession` to replay a resumed session's past
   *  turns into the transcript. */
  getSessionMessagesFn?: typeof getSessionMessages
  /** Passed straight through as `Options.pathToClaudeCodeExecutable`, when resolved. */
  pathToClaudeCodeExecutable?: string
  /**
   * Where the agent's plan files go — Claude Code's own plan directory. The only place
   * `write_plan` can write, and the reason it can be allowed during plan mode at all. Absent
   * leaves the tool unregistered, and the plan file back to costing a prompt.
   */
  plansDir?: string
}

const WRITE_TOOL_NAME = 'propose_edit'
const PLAN_TOOL_NAME = 'write_plan'

/** The plan tool, by either name the SDK may present it under. */
function isPlanTool(name: string): boolean {
  return name === PLAN_TOOL_NAME || name.endsWith(`__${PLAN_TOOL_NAME}`)
}

/**
 * The agent's own plan file, written where the harness keeps it.
 *
 * `Edit`/`Write` are disallowed outright and `propose_edit` is scoped to the repository, so
 * this one file — which lives outside it and belongs to Claude Code rather than to the
 * project — had no sanctioned route at all. The model reached for `cat >` instead, which used
 * to go through silently and now costs a prompt. Neither is right for a file the harness asked
 * it to write.
 *
 * **The destination is built here, not accepted.** `planFileName` keeps nothing but a
 * basename, and that is joined to the one directory this tool can write to — so there is no
 * path for the model to point elsewhere, and no shell text for anything to misparse. It is
 * allowed during plan mode on purpose: writing the plan is planning.
 */
export function buildPlanTool(plansDir: string) {
  return tool(
    PLAN_TOOL_NAME,
    'Write your plan file. This is the only way to write it in this workspace — Edit and Write ' +
      'are unavailable, and the repository write tool cannot reach outside the project. Give ' +
      'the file name the harness told you to use; only the name is used, and the file always ' +
      "lands in this session's plan directory.",
    {
      path: z.string().describe('The plan file name, or the full path you were given.'),
      content: z.string().describe('The plan, as markdown.'),
    },
    async (args: { path: string; content: string }) => {
      const name = planFileName(args.path)
      if (name === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${args.path} is not a usable plan file name. Use a plain markdown filename.`,
            },
          ],
          isError: true,
        }
      }
      const destination = joinPath(plansDir, name)
      try {
        await mkdir(plansDir, { recursive: true })
        await writeTextFile(destination, args.content)
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not write ${destination}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: `Wrote ${destination}.` }] }
    },
  )
}

/**
 * The one way a file can be touched, built once per connection and registered as
 * an in-process MCP server (`createSdkMcpServer`) — no HTTP server, no per-request transport,
 * unlike the ACP-era `propose_edit` MCP route this replaces. The handler is a thin translator:
 * it normalizes an absolute path to repo-relative (Claude Code's own Edit/Write/Read tools use
 * absolute paths, and a model trained on those conventions may send one here too even though
 * the schema says repo-relative) and calls `writeFile` — all actual gating/write logic lives in
 * `app/session.ts`'s `runToolWrite`, not here.
 *
 * Exported (not just used internally) so tests can call `.handler(...)` directly, without
 * going through a live `query()` connection at all. Deliberately not return-type-annotated:
 * the specific zod shape has to flow through from `tool()`'s inferred return, or `.handler`'s
 * `args` parameter collapses to `never`.
 */
export function buildWriteTool(writeFile: WriteFile, cwd: string) {
  return tool(
    WRITE_TOOL_NAME,
    "The only way to change a file's contents in this workspace. Depending on this " +
      "session's review mode, a change either lands immediately (reviewed together with the " +
      "rest of this turn once you finish) or is held for a human's decision first, with the " +
      "reasoning returned here if it's rejected — revise and call this again rather than " +
      'asking what changed. Omit old_text to create a file or replace it wholly; supply ' +
      'old_text — matched exactly, first occurrence replaced — to change part of an ' +
      'existing file.',
    {
      path: z.string().describe('Repo-relative path of the file to write.'),
      old_text: z
        .string()
        .optional()
        .describe('Exact text to replace. Omit to create the file or replace it wholly.'),
      new_text: z
        .string()
        .describe('The replacement text, or the whole file when old_text is omitted.'),
    },
    async ({ path, old_text, new_text }) => {
      const repoRelativePath = isAbsolute(path) ? relative(cwd, path) : path
      const result = await writeFile({
        path: repoRelativePath,
        oldText: old_text ?? null,
        newText: new_text,
      })
      const text =
        result.decision === 'allow'
          ? `Applied. ${repoRelativePath} now reads:\n\n${result.fileContent}`
          : result.reasoning
      return { content: [{ type: 'text', text }] }
    },
  )
}

/** Whether `name` is our own write tool, bare or fully-qualified (`mcp__turnstile__propose_edit`
 *  — the form tool_use blocks and `canUseTool` actually see it under). */
function isWriteTool(name: string): boolean {
  return name === WRITE_TOOL_NAME || name.endsWith(`__${WRITE_TOOL_NAME}`)
}

/** Which tool a `tool_use` block's `title`/`toolKind` come from, mirroring the labels the ACP
 *  proxy used to compose server-side — the SDK gives only a bare name and input. */
function toolKindOf(name: string): string {
  if (name === 'Bash') return 'execute'
  if (name === 'Read') return 'read'
  if (name === 'Glob' || name === 'Grep') return 'search'
  if (name === 'WebFetch' || name === 'WebSearch') return 'fetch'
  if (isWriteTool(name)) return 'edit'
  if (name === 'Agent') return 'agent'
  return 'other'
}

function titleFor(name: string, input: Record<string, unknown>): string {
  const field = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' ? value : null
  }
  if (name === 'Bash') return field('command') ?? name
  if (name === 'Read' || name === 'Write') return field('file_path') ?? name
  if (name === 'Grep' || name === 'Glob') return field('pattern') ?? name
  if (name === 'WebFetch') return field('url') ?? name
  if (isWriteTool(name)) return field('path') ?? name
  if (name === 'Agent') return field('description') ?? name
  return name
}

/**
 * Converts a resumed session's stored history (from the SDK's `getSessionMessages`) into the
 * same `AgentEvent`s a live turn would have produced, so `loadSession` can replay them through
 * `onEvent` before the transcript's normal live fold ever sees the session. Each stored message
 * corresponds to one already-complete content block (the JSONL splits a streamed turn's
 * thinking/text/tool_use blocks into separate chronological entries rather than one combined
 * array — confirmed against this repo's own real session history), unlike the live path's
 * `stream_event` deltas, so text/thinking are emitted whole rather than merged in from
 * fragments — `appendEvent`'s own consecutive-same-kind merge handles them identically either
 * way.
 *
 * Keeps its own local pending-tool map rather than sharing the connection's live `pendingTools`
 * (see `openQuery`): replay runs before the live query ever opens, and reusing that map would
 * leave a stale id in it for the live stream to trip over later.
 */
export function agentEventsFromSessionMessages(messages: SessionMessage[]): AgentEvent[] {
  const events: AgentEvent[] = []
  const pending = new Map<string, { title: string; toolKind: string }>()
  /**
   * `ExitPlanMode` calls seen so far, by tool-use id, with the plan each carried.
   *
   * A plan is not a tool row. Replayed as one it read "ExitPlanMode" and nothing else, with the
   * plan text — the whole substance of it — dropped on the floor, which is what made a resumed
   * session look like it had never had a plan at all. Held until the matching `tool_result`
   * says how it went, since the outcome is the half that makes it worth reading back.
   */
  const plans = new Map<string, { text: string; round: number }>()
  let planRound = 0

  for (const entry of messages) {
    if (entry.type === 'user') {
      const message = entry.message as { content?: unknown }
      const content = message.content
      if (typeof content === 'string') {
        events.push({ kind: 'user', text: content })
        continue
      }
      if (Array.isArray(content)) {
        for (const block of content as {
          type: string
          tool_use_id?: string
          is_error?: boolean
        }[]) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const plan = plans.get(block.tool_use_id)
            if (plan !== undefined) {
              plans.delete(block.tool_use_id)
              // A refusal comes back as the tool call's error — that is how the reasoning
              // reaches the agent in the first place (see `canUseTool`).
              events.push({
                kind: 'plan',
                text: plan.text,
                round: plan.round,
                outcome: block.is_error === true ? 'sent-back' : 'approved',
              })
              continue
            }
            const known = pending.get(block.tool_use_id)
            pending.delete(block.tool_use_id)
            events.push({
              kind: 'tool',
              id: block.tool_use_id,
              title: known?.title ?? '',
              toolKind: known?.toolKind ?? 'other',
              status: block.is_error === true ? 'failed' : 'completed',
            })
          }
        }
      }
      continue
    }

    if (entry.type === 'assistant') {
      const message = entry.message as { content?: unknown }
      const content = message.content
      if (!Array.isArray(content)) continue
      for (const block of content as {
        type: string
        thinking?: string
        text?: string
        id?: string
        name?: string
        input?: unknown
      }[]) {
        if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking !== ''
        ) {
          events.push({ kind: 'thought', text: block.thinking })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          events.push({ kind: 'assistant', text: block.text })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (block.name === 'ExitPlanMode') {
            const input = (block.input as Record<string, unknown>) ?? {}
            planRound += 1
            plans.set(block.id, {
              text: typeof input.plan === 'string' ? input.plan : '',
              round: planRound,
            })
            // No tool row: the plan's own entry stands in for it, once its result says how it
            // went. A plan that was never answered — the session ended mid-decision — leaves
            // nothing, which is honest: nothing was decided.
            continue
          }
          const title = titleFor(block.name ?? '', (block.input as Record<string, unknown>) ?? {})
          const toolKind = toolKindOf(block.name ?? '')
          pending.set(block.id, { title, toolKind })
          events.push({ kind: 'tool', id: block.id, title, toolKind, status: 'pending' })
        }
      }
    }
  }

  /**
   * The last plan of a session is still on the table unless it was approved.
   *
   * Two ways to end up there, and the reader wants the same thing in both. The session died
   * mid-decision — in which case the stored result is Claude Code's own "the user doesn't want
   * to proceed", written because the process went away rather than because anybody decided
   * anything. Or it was sent back and the agent never replaced it: it answered in prose, or
   * asked a question, or was interrupted. Measured against a real agent, whether a refusal
   * produces a revised plan is not something to rely on.
   *
   * Either way the plan is the last one there is, nobody accepted it, and resuming used to file
   * it as history and show nothing — leaving no way back to the one document the session was
   * about. An approved plan is the only one genuinely finished with.
   */
  const lastPlan = events.findLast((event) => event.kind === 'plan')
  if (lastPlan?.kind === 'plan' && lastPlan.outcome !== 'approved') {
    events[events.lastIndexOf(lastPlan)] = { ...lastPlan, outcome: 'standing' }
  }

  return events
}

/**
 * `SDKTaskUpdatedMessage.patch.status` has its own six-value vocabulary
 * (`pending|running|completed|failed|killed|paused`), wider than the four-value one the other
 * task_* branches emit (`running|completed|failed|stopped`) — collapsed here rather than
 * widening `AgentEvent`'s status to match: `pending`/`paused` both still read as "not done, no
 * more specific word for it" than running, and `killed` is, for a reader, the same outcome as
 * `stopped`. `undefined` (the patch didn't touch status) passes through as `null`, meaning "no
 * change asserted" — see the `AgentEvent` doc comment on this field.
 */
function mapTaskUpdatedStatus(status: string | undefined): string | null {
  if (status === undefined) return null
  if (status === 'pending' || status === 'running' || status === 'paused') return 'running'
  if (status === 'killed') return 'stopped'
  return status
}

/** A minimal, unbounded async queue: `push` never blocks, and the iterable's `next()` awaits
 *  until something is pushed. What feeds `query()`'s streaming-input `prompt`. */
function createAsyncQueue<T>(): { push: (item: T) => void; iterable: AsyncIterable<T> } {
  const buffer: T[] = []
  let wake: (() => void) | null = null

  return {
    push(item: T): void {
      buffer.push(item)
      const resolve = wake
      wake = null
      resolve?.()
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<T>> {
            while (buffer.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            return { value: buffer.shift() as T, done: false }
          },
        }
      },
    },
  }
}

/** Best-effort parse of an `AskUserQuestion` call's `questions` input into `AgentQuestion[]` —
 *  defensive because it crosses the SDK boundary as loosely-typed JSON, not a value this
 *  module controls the shape of. */
function parseQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const q = (entry ?? {}) as Record<string, unknown>
    const rawOptions = Array.isArray(q.options) ? q.options : []
    return {
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options: rawOptions.map((option) => {
        const o = (option ?? {}) as Record<string, unknown>
        return {
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : '',
        }
      }),
    }
  })
}

/**
 * Claude Code options that keep the agent out of `dirs`, verified live against a real session:
 *
 * - `Read`/`Edit` deny rules stop the built-in file tools (Read, Grep, Glob, …). On their own
 *   they are text matching, like `reservedPathIn`: `cat` on the path was refused, but
 *   `grep -r` from a parent directory and `python3 -c "open(...)"` read the file.
 * - The sandbox runs every Bash command under an OS-level policy (Seatbelt on macOS, bubblewrap
 *   on Linux) that denies reading and writing `dirs` — `cat`, `grep -r`, `python` all got
 *   "Operation not permitted". `allowWrite: ['/']` keeps it from also confining writes to the
 *   checkout (writing `/tmp` or `~` otherwise fails), so the sandbox only takes away `dirs`.
 *   Network access still works: each new host arrives at `canUseTool` as `SandboxNetworkAccess`
 *   and is approved like any other tool.
 * - `autoAllowBashIfSandboxed: false`, so every Bash call still reaches `canUseTool` — the sudo
 *   floor and `denyPatterns` would otherwise be skipped for sandboxed commands.
 * - A command can ask to run outside the sandbox (`dangerouslyDisableSandbox`); `canUseTool`
 *   puts every such request to the human rather than auto-approving it.
 * - `failIfUnavailable: false`: where the sandbox cannot start (Linux without bubblewrap), the
 *   agent still runs, protected by the deny rules and `reservedPathIn` alone, rather than not
 *   at all.
 */
export function protectionOptions(dirs: readonly string[]): Pick<Options, 'settings' | 'sandbox'> {
  if (dirs.length === 0) return {}
  return {
    // `//` marks an absolute path in a permission rule.
    settings: {
      permissions: { deny: dirs.flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]) },
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      failIfUnavailable: false,
      filesystem: { allowWrite: ['/'], denyRead: [...dirs], denyWrite: [...dirs] },
    },
  }
}

/** Permission gating for every tool call not covered by `disallowedTools` (Bash and anything
 *  else) — the direct analog of ACP's `requestPermission`, wired to the same pending-map-by-id
 *  pattern. Edit/Write never reach `canUseTool` at all (they're disallowed outright), so this
 *  only ever gates non-edit tools.
 *
 * The write tool itself is explicitly bypassed here too — found live, against a real session:
 * without this, `canUseTool` intercepts a call to it before its own handler ever runs,
 * surfacing a redundant "Allow mcp__turnstile__propose_edit?" prompt on top of the gating the
 * handler (`runToolWrite`, via `writeFile`) already does correctly. A second, generic gate in
 * front of it isn't just noise — since nothing here ever answers it, it silently deadlocks
 * every write.
 *
 * `AskUserQuestion` is also special-cased ahead of `isAutoApprovedTool`, for the mirror-image
 * reason: the SDK routes it through this same `canUseTool` callback (see the Agent SDK's "user
 * input" guide), and it used to fall straight into the denylist's "everything auto-approves by
 * default" path — meaning Claude's clarifying questions were silently rubber-stamped with
 * whatever input it proposed, `answers` included, and never actually reached a human. Answering
 * it correctly means resolving with `{ questions, answers }` in `updatedInput`, not a plain
 * allow/deny, so it needs its own event shape (`kind: 'question'`) rather than the flat
 * options list the generic prompt below sends.
 *
 * `isAutoApprovedTool` (see `core/toolSafety.ts`) is checked next, before a prompt is ever
 * raised: supplying `canUseTool` at all opts out of Claude Code's own built-in read-only
 * detection (a plain `git status` or `cat` would never prompt in the bare CLI), and without
 * this check Turnstile would prompt for everything, always. It's a denylist, not an allowlist:
 * everything auto-approves except the hardcoded `sudo` floor and whatever the user configured
 * in `toolPermissions.denyPatterns`; only those get the human prompt below.
 *
 * `ExitPlanMode` is special-cased ahead of everything else, for the same reason
 * `AskUserQuestion` is: the SDK routes it through this same callback, and without a case for it
 * by name it would fall straight into the denylist and auto-allow, meaning a submitted plan
 * would never actually reach a human. Confirmed live against a real session that the plan text
 * is on `input.plan` directly (the SDK's own type defs only document a deprecated field there)
 * — so it's read straight off `input`, never reconstructed from transcript text.
 *
 * The write-tool bypass just below is now conditional on `planModeRef`: confirmed live that the
 * model itself never attempts a write while genuinely in plan mode, but nothing here should
 * depend on that restraint holding — denying it explicitly is defense in depth, the same
 * fail-closed posture `compileDenyPatterns` already takes elsewhere in this file.
 */
function buildCanUseTool(
  onEvent: (event: AgentEvent) => void,
  denyPatterns: readonly RegExp[],
  reservedPaths: readonly string[],
  requestPlanApproval: RequestPlanApproval,
  planModeRef: { current: PlanModeStatus },
): {
  canUseTool: CanUseTool
  answer: (id: string, optionId: string) => void
  answerQuestion: (id: string, answers: Record<string, string | string[]>) => void
} {
  const pending = new Map<string, (optionId: string) => void>()
  const pendingQuestions = new Map<string, (answers: Record<string, string | string[]>) => void>()
  let counter = 0

  const canUseTool: CanUseTool = async (toolName, input, callOptions) => {
    // First, ahead of the write tool and every auto-approval: Turnstile's own state is not the
    // agent's to read or change. Refused outright rather than put to the human — there is no
    // case for letting it through.
    if (reservedPathIn(input, reservedPaths) !== null) {
      return {
        behavior: 'deny',
        message: "That path is reserved for Turnstile and isn't available in this session.",
      }
    }

    // Writing the plan is planning, so this one is allowed while plan mode is on — which is the
    // entire reason it exists. It can only write a filename of its own choosing into one
    // directory, so there is nothing here that a deny rule or the mode needs to protect.
    if (isPlanTool(toolName)) return { behavior: 'allow' }

    if (isWriteTool(toolName)) {
      if (planModeRef.current === 'plan') {
        return {
          behavior: 'deny',
          message: 'Still in plan mode — call ExitPlanMode before editing files.',
        }
      }
      return { behavior: 'allow' }
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : ''
      const result = await requestPlanApproval(plan)
      return result.decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: result.reasoning }
    }

    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input)
      counter += 1
      const id = `question-${counter}`

      // No timeout, deliberately, same as the generic permission prompt below: the agent is
      // blocked and the turn cannot proceed, so a request that expired on its own would resume
      // work nobody actually answered.
      const answers = await new Promise<Record<string, string | string[]>>((resolve) => {
        pendingQuestions.set(id, resolve)
        onEvent({ kind: 'question', id, questions })
      })

      pendingQuestions.delete(id)
      onEvent({ kind: 'question-resolved', id })
      return { behavior: 'allow', updatedInput: { questions, answers } }
    }

    // A command asking to leave the sandbox would leave the protected directories with it.
    const unsandboxed = toolName === 'Bash' && input.dangerouslyDisableSandbox === true

    /**
     * Plan mode used to stop at the write tool and nowhere else, which was not enough.
     *
     * `isWriteTool` above was the only thing plan mode checked, and every other tool —
     * `Bash` first among them — fell straight through to the denylist and auto-approved. So an
     * agent restricted to planning could not call `propose_edit`, and could still write
     * anywhere in the checkout with `cat >`, `sed -i` or a heredoc, silently. The README's
     * promise that it "can only read and plan until you approve" was not true.
     *
     * The OS sandbox cannot answer this: `buildOptions` runs once per query, and plan mode
     * turns on and off inside a live one — including from inside this very callback, when a
     * plan is approved. This gate is the only thing that sees the mode change.
     *
     * Declining here is not denying: the call goes to the human with plan mode named as the
     * reason. Installing a dependency while planning stays possible, and stops being silent.
     */
    const planRestricted =
      planModeRef.current === 'plan' && !unsandboxed && !isReadOnlyCall(toolName, input)
    const autoApproved = isAutoApprovedTool(toolName, input, denyPatterns)

    if (!unsandboxed && !planRestricted && autoApproved) {
      return { behavior: 'allow' }
    }

    counter += 1
    const id = `perm-${counter}`

    // Composed from the call itself rather than taken from `callOptions.title`: the SDK
    // documents that field as the rendered prompt sentence, but it arrives undefined for every
    // call Turnstile actually gates, which left every prompt reading a bare "Allow Bash?" with
    // no sight of the command. See `core/permissionPrompt.ts`.
    const prompt = describePermissionRequest(toolName, input, {
      title: callOptions.title,
      blockedPath: callOptions.blockedPath,
      // Only when plan mode is the whole reason. A call the user's own deny pattern already
      // refuses should say so — that rule outlives the mode.
      planRestricted: planRestricted && autoApproved,
    })

    // No timeout, deliberately: the agent is blocked and the turn cannot proceed, so a
    // request that expired on its own would resume work nobody approved.
    const optionId = await new Promise<string>((resolve) => {
      pending.set(id, resolve)
      onEvent({
        kind: 'permission',
        id,
        title: prompt.title,
        subject: prompt.subject,
        description: prompt.description,
        reason: prompt.reason,
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      })
    })

    pending.delete(id)
    onEvent({ kind: 'permission-resolved', id })
    return optionId === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by the user.' }
  }

  return {
    canUseTool,
    answer: (id, optionId) => pending.get(id)?.(optionId),
    answerQuestion: (id, answers) => pendingQuestions.get(id)?.(answers),
  }
}

/**
 * The protocol half, over any `query()` implementation — transport-injectable so tests can
 * drive a scripted message stream without spawning a real subprocess or calling a real model,
 * the same shape `connectAcpClient` gave the ACP adapter.
 */
export function connectAgentSdk(options: AgentSdkClientOptions): AgentConnection {
  const { cwd, onEvent, writeFile, requestPlanApproval } = options
  const queryFn = options.queryFn ?? query
  const getSessionMessagesFn = options.getSessionMessagesFn ?? getSessionMessages
  const deniedPatterns = compileDenyPatterns(options.denyPatterns ?? [])

  const plansDir = options.plansDir
  const server = createSdkMcpServer({
    name: 'turnstile',
    tools:
      plansDir === undefined
        ? [buildWriteTool(writeFile, cwd)]
        : [buildWriteTool(writeFile, cwd), buildPlanTool(plansDir)],
  })
  /** Mirrors the SDK's own permission mode, for the write-tool bypass gate above — updated both
   *  optimistically (by this connection's own `setPermissionMode`, before the SDK round-trips)
   *  and authoritatively (by `dispatch()`'s `system/init`/`system/status` handling, which also
   *  covers a model-suggested mode change this connection didn't itself initiate). */
  const planModeRef: { current: PlanModeStatus } = { current: 'default' }
  const {
    canUseTool,
    answer,
    answerQuestion: resolveQuestion,
  } = buildCanUseTool(
    onEvent,
    deniedPatterns,
    options.reservedPaths ?? [],
    requestPlanApproval,
    planModeRef,
  )

  let current: Query | null = null
  let push: ((message: SDKUserMessage) => void) | null = null
  /** The turn in flight, settled by its `result` message — or failed, if the process dies first. */
  let pendingResult: {
    resolve: (stopReason: string) => void
    reject: (error: Error) => void
  } | null = null
  /**
   * The conversation this connection drives, kept so a process that dies can be replaced (see
   * `openQuery`), and whether the SDK has begun it yet — a conversation that never began has
   * nothing to resume, and must be started afresh under the same id instead. Null once stopped.
   */
  let conversation: { sessionId: string; begun: boolean } | null = null
  /** Set for the span of one `cancel()`, so the malformed `error_during_execution` result the
   *  SDK produces when interrupting before any assistant content streamed (a confirmed open
   *  SDK bug — see `client.test.ts`) is recognised as a clean cancellation instead of surfaced
   *  as `agent-error`. The query itself recovers fine for the next prompt either way. */
  let weInterrupted = false

  /** What a `tool_use` needs remembered until its matching `tool_result` arrives — a
   *  `tool_result` block carries only `tool_use_id`, never the tool's name, so without this
   *  its completion event would have no real `toolKind`/`title` to report. Cleared whenever a
   *  query is abandoned (see `openQuery`/`stop`) so an id whose `tool_result` never arrives
   *  (interrupted mid-call, connection torn down) can't accumulate forever. */
  const pendingTools = new Map<string, { title: string; toolKind: string }>()

  /**
   * `resume` reopens a past conversation by its real id; otherwise `sessionId` pins a fresh
   * one to an id we already chose (see `openQuery` for why this matters — the SDK does not
   * assign or reveal a session id until the first prompt is actually processed, which is too
   * late for `start()`/`newSession()` to hand back synchronously).
   */
  function buildOptions(resume: string | undefined, sessionId: string): Options {
    return {
      cwd,
      mcpServers: { turnstile: server },
      disallowedTools: ['Edit', 'Write'],
      canUseTool,
      ...protectionOptions(options.protectedDirs ?? []),
      includePartialMessages: true,
      // `Options.env`, when set, REPLACES process.env rather than merging — must spread it
      // explicitly or PATH/ANTHROPIC_API_KEY vanish for the subprocess.
      env: { ...process.env },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          `File edits in this session go through the mcp__turnstile__${WRITE_TOOL_NAME} tool, ` +
          "not Edit or Write — it is the only way to change a file's contents here." +
          (plansDir === undefined
            ? ''
            : ` Write your plan file with the mcp__turnstile__${PLAN_TOOL_NAME} tool rather ` +
              'than with a shell command; it is the only way to write it here, and it works ' +
              'while plan mode is on.'),
      },
      ...(resume !== undefined ? { resume } : { sessionId }),
      ...(options.pathToClaudeCodeExecutable !== undefined
        ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
        : {}),
    }
  }

  async function reportUsage(): Promise<void> {
    try {
      const usage = await current?.getContextUsage()
      if (usage !== undefined) {
        onEvent({
          kind: 'usage-update',
          contextUsed: usage.totalTokens,
          contextSize: usage.rawMaxTokens,
        })
      }
    } catch {
      // Best-effort: a status-bar figure is not worth failing a turn over.
    }
  }

  function dispatch(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      onEvent({ kind: 'config-update', model: message.model, thinkingLevel: null })
      planModeRef.current = message.permissionMode === 'plan' ? 'plan' : 'default'
      onEvent({ kind: 'plan-mode-update', mode: planModeRef.current })
      return
    }

    // Confirmed live that a mode transition (including a model-suggested one this connection
    // didn't itself initiate) surfaces here — no `SDKConversationResetMessage` was observed
    // around a plan-mode transition in testing, so nothing else needs handling for that.
    if (message.type === 'system' && message.subtype === 'status') {
      if (message.permissionMode !== undefined) {
        planModeRef.current = message.permissionMode === 'plan' ? 'plan' : 'default'
        onEvent({ kind: 'plan-mode-update', mode: planModeRef.current })
      }
      return
    }

    // The task_* family exists specifically to surface subagent (the `Agent` tool's) activity
    // live, rather than as a single opaque tool_use/tool_result pair that goes silent for the
    // duration of a backgrounded run — see the doc comment on `Options.forwardSubagentText` in
    // the SDK's own types, which names task_progress's last_tool_name/usage as "enough for a
    // heartbeat counter" without needing the full nested subagent transcript that flag forwards.
    // Kept as a distinct `AgentEvent` kind (`subagent`), not folded into `tool`, since a
    // backgrounded subagent's real lifecycle is independent of its launching tool_use's own
    // quick pending→completed pair.
    if (message.type === 'system' && message.subtype === 'task_started') {
      // "Ambient/housekeeping task. Consumers should hide this from the inline transcript" —
      // the SDK's own doc comment on `skip_transcript`.
      if (message.skip_transcript === true) return
      onEvent({
        kind: 'subagent',
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? null,
        status: 'running',
        description: message.description,
        subagentType: message.subagent_type ?? null,
        lastToolName: null,
        toolUses: null,
        summary: null,
      })
      return
    }

    if (message.type === 'system' && message.subtype === 'task_progress') {
      onEvent({
        kind: 'subagent',
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? null,
        status: 'running',
        description: message.description,
        subagentType: message.subagent_type ?? null,
        lastToolName: message.last_tool_name ?? null,
        toolUses: message.usage.tool_uses,
        summary: null,
      })
      return
    }

    if (message.type === 'system' && message.subtype === 'task_updated') {
      // A wire-safe partial patch, not a full snapshot — only `status`/`description` are ever
      // read here since those are the only patch fields the transcript renders; whichever the
      // patch omits comes through as `null` and `appendEvent`'s merge keeps whatever the
      // transcript already had for it.
      onEvent({
        kind: 'subagent',
        taskId: message.task_id,
        toolUseId: null,
        status: mapTaskUpdatedStatus(message.patch.status),
        description: message.patch.description ?? null,
        subagentType: null,
        lastToolName: null,
        toolUses: null,
        summary: null,
      })
      return
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      onEvent({
        kind: 'subagent',
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? null,
        status: message.status,
        description: null,
        subagentType: null,
        lastToolName: null,
        toolUses: null,
        summary: message.summary,
      })
      return
    }

    if (message.type === 'stream_event') {
      const event = message.event as unknown as {
        type?: string
        delta?: { type?: string; text?: string; thinking?: string }
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          onEvent({ kind: 'assistant', text: event.delta.text })
        } else if (
          event.delta?.type === 'thinking_delta' &&
          typeof event.delta.thinking === 'string'
        ) {
          onEvent({ kind: 'thought', text: event.delta.thinking })
        }
      }
      return
    }

    if (message.type === 'assistant') {
      const content = message.message.content as unknown as
        | { type: string; id?: string; name?: string; input?: unknown }[]
        | string
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && typeof block.id === 'string') {
            // A plan is not a tool row. `session.ts` records it — with what was decided about
            // it — when `requestPlanApproval` settles, so a row here would be the same plan
            // announced twice, once as an opaque tool name.
            if (block.name === 'ExitPlanMode') continue
            const title = titleFor(block.name ?? '', (block.input as Record<string, unknown>) ?? {})
            const toolKind = toolKindOf(block.name ?? '')
            pendingTools.set(block.id, { title, toolKind })
            onEvent({ kind: 'tool', id: block.id, title, toolKind, status: 'pending' })
          }
        }
      }
      return
    }

    if (message.type === 'user') {
      const content = message.message.content as unknown as
        | { type: string; tool_use_id?: string; is_error?: boolean }[]
        | string
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const known = pendingTools.get(block.tool_use_id)
            pendingTools.delete(block.tool_use_id)
            onEvent({
              kind: 'tool',
              id: block.tool_use_id,
              title: known?.title ?? '',
              toolKind: known?.toolKind ?? 'other',
              status: block.is_error === true ? 'failed' : 'completed',
            })
          }
        }
      }
      return
    }

    if (message.type === 'result') {
      void (async () => {
        await reportUsage()

        const resolve = pendingResult?.resolve
        pendingResult = null
        const interrupted = weInterrupted
        weInterrupted = false

        if (message.subtype === 'success') {
          resolve?.(message.stop_reason ?? 'end_turn')
          return
        }
        if (message.subtype === 'error_during_execution' && interrupted) {
          resolve?.('cancelled')
          return
        }
        onEvent({
          kind: 'agent-error',
          message: message.errors.join('; ') || message.subtype,
        })
        resolve?.(message.subtype)
      })()
    }
  }

  /**
   * Opens a fresh `Query` and returns its session id immediately — not once anything comes
   * back from the SDK. Confirmed directly against a real query(): in streaming-input mode the
   * subprocess does not emit `system/init` (or assign/reveal a session id at all) until the
   * first message is actually pulled off the prompt iterable — which cannot happen before
   * `start()` resolves, since nothing has been prompted yet at that point.
   * Waiting for it here would deadlock forever on an idle, freshly-opened session.
   *
   * `Options.sessionId` is what makes this safe rather than a guess: the caller picks the id
   * up front (`fresh` — `session.ts` needs it before the agent exists, to name the session's
   * worktree) rather than waiting for one to be assigned, and the SDK uses exactly
   * that id everywhere once the conversation is actually created — confirmed against a real
   * run, where every message downstream (including the eventual `system/init`) carries the
   * chosen id back. `loadSession` has a real id already (from `AgentHistory.listSessions`), so it passes
   * `resume` instead and returns that same id straight back.
   */
  function openQuery(resume: string | undefined, fresh: string): string {
    const sessionId = resume ?? fresh
    conversation = { sessionId, begun: resume !== undefined }
    current?.close()
    pendingTools.clear()

    const queue = createAsyncQueue<SDKUserMessage>()
    push = queue.push

    const q = queryFn({ prompt: queue.iterable, options: buildOptions(resume, sessionId) })
    current = q
    void (async () => {
      let reason = 'Claude Code exited unexpectedly'
      try {
        for await (const message of q) {
          // Anything at all back from the SDK means it has taken the first prompt, and with it
          // created the conversation on disk.
          if (q === current && conversation !== null) conversation.begun = true
          dispatch(message)
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
      }
      // Replaced or stopped on purpose — closing it is what ended it, and nothing is waiting on it.
      if (q !== current) return
      processDied(reason)
    })()

    return sessionId
  }

  /**
   * The live query's process ended without being asked to: killed by the OS (macOS refusing a
   * binary whose code signature it no longer trusts), crashed, or exited. Nothing will ever
   * answer a prompt pushed into it, so the turn waiting on one fails with the reason — reported
   * as an error on its own when no turn is waiting — and the next prompt starts a new process
   * (`prompt`). Without this a dead process left the turn "thinking" forever.
   */
  function processDied(reason: string): void {
    current = null
    push = null
    pendingTools.clear()
    weInterrupted = false
    const waiting = pendingResult
    pendingResult = null
    if (waiting !== null) waiting.reject(new Error(reason))
    else onEvent({ kind: 'agent-error', message: reason })
  }

  return {
    async start(sessionId: string): Promise<string> {
      return openQuery(undefined, sessionId)
    },

    async loadSession(sessionId: string): Promise<string> {
      try {
        const messages = await getSessionMessagesFn(sessionId, { dir: cwd })
        for (const event of agentEventsFromSessionMessages(messages)) onEvent(event)
      } catch (error) {
        onEvent({
          kind: 'agent-error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return openQuery(sessionId, sessionId)
    },

    async prompt(text: string): Promise<string> {
      // The last process died (`processDied`): carry on the same conversation in a new one.
      if (current === null && conversation !== null) {
        const { sessionId, begun } = conversation
        openQuery(begun ? sessionId : undefined, sessionId)
      }
      weInterrupted = false
      const result = new Promise<string>((resolve, reject) => {
        pendingResult = { resolve, reject }
      })
      push?.({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      })
      return result
    },

    async cancel(): Promise<void> {
      weInterrupted = true
      await current?.interrupt()
    },

    answerPermission(id: string, optionId: string): void {
      answer(id, optionId)
    },

    answerQuestion(id: string, answers: Record<string, string | string[]>): void {
      resolveQuestion(id, answers)
    },

    async setPermissionMode(mode): Promise<void> {
      planModeRef.current = mode
      await current?.setPermissionMode(mode)
    },

    stop(): void {
      const closing = current
      current = null
      push = null
      conversation = null
      closing?.close()
      pendingTools.clear()
    },
  }
}

/** The real thing: drives the actual Claude Agent SDK. */
export function createAgentSdkClient(
  options: Omit<
    AgentSdkClientOptions,
    'queryFn' | 'getSessionMessagesFn' | 'pathToClaudeCodeExecutable'
  >,
): AgentConnection {
  return connectAgentSdk({ ...options, pathToClaudeCodeExecutable: resolveExecutable() })
}

/** Past conversations run in `dir`, read straight from the SDK's own session files — no
 *  connection needed. */
export function createAgentHistory(dir: string): AgentHistory {
  return {
    async listSessions(): Promise<SessionSummary[]> {
      const sessions = await listSdkSessions({ dir })
      return sessions
        .map((session) => ({
          sessionId: session.sessionId,
          title: session.customTitle ?? session.firstPrompt ?? null,
          updatedAt: new Date(session.lastModified).toISOString(),
        }))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    },
  }
}
