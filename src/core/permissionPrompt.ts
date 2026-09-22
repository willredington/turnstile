/**
 * Turns a tool call that could not be auto-approved into something a human can actually decide
 * about.
 *
 * The prompt used to read `callOptions.title ?? \`Allow ${toolName}?\``, which in practice meant
 * every single one said "Allow Bash?" and nothing else: the Agent SDK documents `title` as the
 * "full permission prompt sentence rendered by the bridge", but it arrives undefined for the
 * calls Turnstile actually gates (verified live against a real session — `title` was null on
 * every one, while `displayName`, `description`, `blockedPath` and `decisionReason` were
 * populated). A reader was being asked to approve a command they could not see.
 *
 * So the sentence is composed here instead, from the call itself, and only falls back to the
 * bridge's `title` where the bridge has something to say and we don't. Kept in `core` and pure,
 * next to `activity.ts`, since it is presentation logic over domain types with no I/O — and so
 * the exact wording is testable without a subprocess.
 */

import { containsSudoInvocation } from './toolSafety.ts'

/** Why a call reached a human at all. Ordered by how much it matters: a command asking to run
 *  as root is worth saying even when it also asks to leave the sandbox. */
export type PermissionCause = 'sudo' | 'sandbox-escape' | 'plan-mode' | 'deny-pattern'

export type PermissionPrompt = {
  /** The question itself, naming what is actually being asked rather than just the tool. */
  title: string
  /** The concrete thing under question — a command, a URL, a path. Rendered verbatim, in
   *  monospace, so the reader approves what will actually run. Null when the input has nothing
   *  worth quoting. */
  subject: string | null
  /** The agent's own one-line account of what it is doing, when it supplied one. */
  description: string | null
  /** Why this needed a human, in a sentence — the part that was missing entirely before. */
  reason: string | null
}

/** Extra context the SDK's `canUseTool` hands us alongside the call. All optional: the bridge
 *  populates these unevenly, which is the whole reason this module exists. */
export type PermissionContext = {
  title?: string | undefined
  blockedPath?: string | undefined
  /** Set when plan mode alone is what stopped this call — it would otherwise have run without
   *  asking. Passed in rather than derived, because whether a call only reads is decided by
   *  `toolSafety.ts` and two answers to that question could disagree. */
  planRestricted?: boolean | undefined
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The one field worth quoting back, per tool. Deliberately separate from `client.ts`'s
 * `titleFor`, which labels a tool call in the transcript: that one degrades to the tool's name
 * so a row always reads as something, where this one returns null so the prompt can omit the
 * quote block entirely rather than showing a reader the word "Bash" in a code box.
 */
export function subjectOf(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') return stringField(input, 'command')
  if (toolName === 'WebFetch') return stringField(input, 'url')
  if (toolName === 'Grep' || toolName === 'Glob') return stringField(input, 'pattern')
  return stringField(input, 'file_path') ?? stringField(input, 'path') ?? stringField(input, 'url')
}

function causeOf(
  toolName: string,
  input: Record<string, unknown>,
  planRestricted: boolean,
): PermissionCause {
  const command = toolName === 'Bash' ? stringField(input, 'command') : null
  // Reuses `toolSafety.ts`'s own detector rather than re-deriving one: two sudo checks that
  // could disagree would mean a prompt whose sentence names a different cause than the code
  // that actually refused the call.
  if (command !== null && containsSudoInvocation(command)) return 'sudo'
  if (toolName === 'Bash' && input.dangerouslyDisableSandbox === true) return 'sandbox-escape'
  // Above a deny pattern, because plan mode is the surprising one: it is temporary, the reader
  // turned it on themselves, and it is why a command that ran without asking yesterday is
  // asking today.
  if (planRestricted) return 'plan-mode'
  return 'deny-pattern'
}

function titleFor(cause: PermissionCause, toolName: string, bridgeTitle: string | null): string {
  if (cause === 'sudo') return 'Run a command as root?'
  if (cause === 'sandbox-escape') return 'Run a command outside the sandbox?'
  if (cause === 'plan-mode') return 'Let the agent do this while planning?'
  // Only here is the bridge's sentence better than ours: a deny pattern is the user's own rule,
  // and we have nothing more specific to say about it than the tool's name.
  return bridgeTitle ?? `Allow ${toolName}?`
}

function reasonFor(cause: PermissionCause, blockedPath: string | null): string | null {
  if (cause === 'sudo') {
    return 'This runs as root, which Turnstile never approves on its own.'
  }
  if (cause === 'sandbox-escape') {
    const base =
      'The agent asked to run this outside the OS sandbox, which is what keeps it away from Turnstile’s rules and state.'
    return blockedPath === null ? base : `${base} It was blocked from ${blockedPath}.`
  }
  if (cause === 'plan-mode') {
    return 'Plan mode is on, so the agent is meant to read and plan only — and this does more than read. Allowing it lets this one call through; plan mode stays on.'
  }
  return 'This matches a deny pattern in your .turnstile/config.json.'
}

/**
 * Composes the prompt for a tool call that has already been refused auto-approval. `context`
 * carries whatever the SDK bridge supplied; every field of it is optional and routinely absent.
 */
export function describePermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext = {},
): PermissionPrompt {
  const cause = causeOf(toolName, input, context.planRestricted === true)
  const blockedPath = context.blockedPath ?? null

  return {
    title: titleFor(cause, toolName, context.title ?? null),
    subject: subjectOf(toolName, input),
    description: stringField(input, 'description'),
    reason: reasonFor(cause, blockedPath),
  }
}
