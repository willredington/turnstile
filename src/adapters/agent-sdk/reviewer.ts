import { isAbsolute, relative } from 'node:path'
import {
  type CanUseTool,
  createSdkMcpServer,
  type Options,
  query,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Reviewer, ReviewInput } from '../../core/ports.ts'
import { groupFindings } from '../../core/reviewSubmission.ts'
import { isReadOnlyCall, reservedPathIn } from '../../core/toolSafety.ts'
import type { Finding } from '../../core/types.ts'
import { protectionOptions } from './client.ts'
import { resolveExecutable } from './resolveExecutable.ts'

/**
 * The reviewer: a standard, read-only Claude Code session, run once over the files a turn
 * changed.
 *
 * Claude Code rather than a bare model call because the repository already tells a Claude Code
 * agent how it wants to be worked on — its `CLAUDE.md`, its skills — and a review should hold
 * the change to exactly that. The SDK loads them the way the CLI does (`settingSources` left at
 * its default), so there is nothing here to keep in step with them.
 *
 * Read-only by construction: the only tools offered are reads, searches, skills and Bash, and
 * `canUseTool` lets a Bash command through only when `isReadOnlyCall` vouches for it. The answer
 * comes back through one in-process tool, `submit_findings`, checked as it arrives
 * (`groupFindings`) so a malformed submission is corrected within the run rather than failing it.
 */

const SUBMIT_TOOL_NAME = 'submit_findings'

export type ReviewerOptions = {
  /** A Claude model alias or id; the CLI's own default when unset. */
  model?: string | undefined
  /** How long one review may run before it is abandoned. */
  timeoutMs: number
  /** Model round-trips one review may take. */
  maxTurns: number
  /** Turnstile's own state, kept out of reach exactly as it is for the coding agent. */
  protectedDirs?: string[]
  reservedPaths?: string[]
  /** Overridable so tests never spawn a real subprocess. */
  queryFn?: typeof query
  pathToClaudeCodeExecutable?: string
}

export const REVIEW_SYSTEM_PROMPT = `You are reviewing changes a coding agent just made in this repository, for a human who is
reading the agent's work and deciding where to look closely. You are a reviewer, not a coder:
you cannot change anything, and you should not try.

You are given the files under review and their diff against where the session started. The
rest of the repository is in reach: read files, search, and run read-only shell commands. This
repository's own conventions — its CLAUDE.md, its skills — are the standard to hold the change
to; when a skill covers what changed, use it.

Report problems the CHANGE introduces or leaves broken: a bug, a broken caller or test, a missed
edge case, a security hazard, a departure from how this repository does things. Never report
what the code already did before the change. The agent's work may continue in files it has not
touched yet, so never report something only because this change alone does not finish the job.

Go beyond the diff wherever it matters, and be thorough when you do:
  - If the change alters anything exported — a function's parameters or return type, a type's
    fields, a constant's value — grep for every use of it, tests included, and check each call
    site against the NEW version. A call site the change breaks is a finding at that file and
    line. A type error in a test file breaks the build even when the test runner does not
    type-check.
  - If correctness depends on another file — a test that should exist, the pattern a sibling
    follows, a helper that must be used — read it rather than assuming.
Do not explore for its own sake.

For each finding give:
  - path and startLine/endLine: new-file line numbers, relative to the repository root. Point
    at the lines themselves, not the whole change.
  - cause: only when path is NOT one of the files under review — the file under review whose
    change causes it.
  - severity:
      low    — minor; probably fine, worth a glance.
      medium — a real way this goes wrong; the human should look.
      high   — a serious, concrete hazard: data loss, security, a broken build or critical path.
  - title: a few words, like the subject of a review comment.
  - message: what is wrong and why it matters, in one to three sentences. Be concrete — name the
    call, the value, the case.

MOST CHANGES ARE FINE. An empty list is the expected answer for most reviews, and a finding that
is not real costs the reader more than one that is missed. Do not report something because it
could be cleaner, stricter or more idiomatic, unless the repository's own conventions ask for it.

When you are done, call ${SUBMIT_TOOL_NAME} exactly once with every finding — an empty list if
there are none. If it is not accepted, it says why: fix exactly that and call it again. Nothing
you write outside ${SUBMIT_TOOL_NAME} reaches the reader.`

/** What the reviewer is asked, for one review. */
export function reviewPrompt(input: ReviewInput): string {
  const files = input.files
    .map((file) =>
      file.previousPath === undefined
        ? `  - ${file.path} (${file.kind})`
        : `  - ${file.path} (${file.kind}, from ${file.previousPath})`,
    )
    .join('\n')
  return `Files under review:\n${files}\n\nTheir diff:\n\n${input.diff}`
}

/**
 * The one way the reviewer answers. `accept` receives the first submission that passes
 * `groupFindings`; anything after that is refused, so a second thought cannot quietly replace
 * the answer already taken.
 *
 * Exported so tests can call `.handler(...)` directly. Deliberately not return-type-annotated,
 * for the same reason as `buildWriteTool`: the zod shape has to flow through from `tool()`.
 */
export function buildSubmitTool(
  root: string,
  reviewed: readonly string[],
  accept: (byFile: Map<string, Finding[]>) => void,
) {
  let accepted = false
  return tool(
    SUBMIT_TOOL_NAME,
    'Submit every finding of this review, once, when you are done. An empty list means you ' +
      'found nothing worth the reader’s attention. If the submission is not accepted, the ' +
      'result says why — fix that and call this again.',
    {
      findings: z.array(
        z.object({
          path: z.string().describe('Relative to the repository root.'),
          startLine: z.number().int(),
          endLine: z.number().int(),
          severity: z.enum(['low', 'medium', 'high']),
          title: z.string().describe('A few words, like the subject of a review comment.'),
          message: z.string().describe('What is wrong and why it matters, concretely.'),
          cause: z
            .string()
            .optional()
            .describe(
              'Only when path is not a file under review: the file under review whose change ' +
                'causes this.',
            ),
        }),
      ),
    },
    async ({ findings }) => {
      if (accepted) {
        return { content: [{ type: 'text' as const, text: 'Already submitted.' }] }
      }
      const asRelative = (path: string) => (isAbsolute(path) ? relative(root, path) : path)
      const result = groupFindings(
        reviewed,
        findings.map((finding) => ({
          ...finding,
          path: asRelative(finding.path),
          cause: finding.cause === undefined ? undefined : asRelative(finding.cause),
        })),
      )
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true }
      }
      accepted = true
      accept(result.byFile)
      return { content: [{ type: 'text' as const, text: 'Accepted. The review is done.' }] }
    },
  )
}

const isSubmitTool = (name: string): boolean =>
  name === SUBMIT_TOOL_NAME || name.endsWith(`__${SUBMIT_TOOL_NAME}`)

/** Reads only. Web tools are left out: they are read-only, but the review is about this
 *  repository, and nothing in it should need the network. */
function reviewerCanUseTool(reservedPaths: readonly string[]): CanUseTool {
  return async (toolName, input) => {
    if (reservedPathIn(input, reservedPaths) !== null) {
      return { behavior: 'deny', message: 'That path is reserved for Turnstile.' }
    }
    if (isSubmitTool(toolName) || toolName === 'Skill') return { behavior: 'allow' }
    if (toolName !== 'WebFetch' && toolName !== 'WebSearch' && isReadOnlyCall(toolName, input)) {
      return { behavior: 'allow' }
    }
    return {
      behavior: 'deny',
      message: 'This review is read-only: read, search and read-only shell commands only.',
    }
  }
}

/** The protocol half, over any `query()` implementation. */
export function connectReviewer(options: ReviewerOptions): Reviewer {
  const queryFn = options.queryFn ?? query
  const canUseTool = reviewerCanUseTool(options.reservedPaths ?? [])

  return {
    async review(input) {
      const reviewed = input.files.map((file) => file.path)
      let accepted: Map<string, Finding[]> | null = null
      const server = createSdkMcpServer({
        name: 'review',
        tools: [
          buildSubmitTool(input.root, reviewed, (byFile) => {
            accepted = byFile
          }),
        ],
      })

      // Streaming input, not a string: in-process tools and `canUseTool` both answer over the
      // control channel, which needs the input side kept open until the run is over.
      let finish: () => void = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: reviewPrompt(input) },
          parent_tool_use_id: null,
        } as SDKUserMessage
        await finished
      })()

      const abortController = new AbortController()
      const timer = setTimeout(() => abortController.abort(), options.timeoutMs)
      const sdkOptions: Options = {
        cwd: input.root,
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'],
        skills: 'all',
        mcpServers: { review: server },
        canUseTool,
        ...protectionOptions(options.protectedDirs ?? []),
        // A review is not a conversation anyone will resume, and would otherwise be listed
        // among the project's sessions.
        persistSession: false,
        maxTurns: options.maxTurns,
        abortController,
        // `Options.env` replaces the environment rather than merging into it.
        env: { ...process.env },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: REVIEW_SYSTEM_PROMPT },
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.pathToClaudeCodeExecutable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
      }

      let ending = 'ended without submitting findings'
      try {
        for await (const message of queryFn({ prompt, options: sdkOptions })) {
          if (message.type !== 'result') continue
          if (message.subtype !== 'success')
            ending = `stopped (${message.subtype}) before submitting findings`
          break
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`)
        }
        throw error
      } finally {
        clearTimeout(timer)
        finish()
      }

      const byFile = accepted as Map<string, Finding[]> | null
      if (byFile === null) throw new Error(`The reviewer ${ending}.`)
      return byFile
    },
  }
}

/** The real thing: spawns the Claude Code CLI through the SDK. */
export function createAgentSdkReviewer(
  options: Omit<ReviewerOptions, 'queryFn' | 'pathToClaudeCodeExecutable'>,
): Reviewer {
  return connectReviewer({ ...options, pathToClaudeCodeExecutable: resolveExecutable() })
}
