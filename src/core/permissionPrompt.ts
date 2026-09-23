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

import type { AutoModeVerdict } from './autoMode.ts'

/**
 * Why a call reached a human at all. Plan mode first: it is the surprising one — temporary,
 * turned on by the reader themselves, and why a command that ran without asking an hour ago is
 * asking now. Otherwise it is whatever auto-mode said.
 */
export type PermissionCause = 'plan-mode' | 'flagged' | 'auto-mode-unavailable' | 'auto-mode-off'

/** One of the user's auto-mode statements this call ran into, and how likely the judge thought it. */
export type FlaggedStatement = { text: string; probability: number }

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
  /** The statements that flagged it, most likely first. Empty unless auto-mode flagged it. */
  flagged: FlaggedStatement[]
}

/** Extra context the SDK's `canUseTool` hands us alongside the call. All optional: the bridge
 *  populates these unevenly, which is the whole reason this module exists. */
export type PermissionContext = {
  title?: string | undefined
  blockedPath?: string | undefined
  /** Set when plan mode alone is what stopped this call. Passed in rather than derived, because
   *  whether a call only reads is decided by `toolSafety.ts` and two answers could disagree. */
  planRestricted?: boolean | undefined
  /** What auto-mode said about the call, when it was asked. */
  verdict?: AutoModeVerdict | undefined
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

function causeOf(context: PermissionContext): PermissionCause {
  if (context.planRestricted === true) return 'plan-mode'
  if (context.verdict?.kind === 'flag') return 'flagged'
  if (context.verdict?.kind === 'unavailable') return 'auto-mode-unavailable'
  return 'auto-mode-off'
}

function titleFor(cause: PermissionCause, toolName: string, bridgeTitle: string | null): string {
  if (cause === 'plan-mode') return 'Let the agent do this while planning?'
  if (toolName === 'Bash') return 'Run this command?'
  return bridgeTitle ?? `Allow ${toolName}?`
}

const percent = (probability: number): string => `${Math.round(probability * 100)}%`

function reasonFor(cause: PermissionCause, context: PermissionContext): string {
  const verdict = context.verdict
  if (cause === 'plan-mode') {
    return 'Plan mode is on, so the agent is meant to read and plan only — and this does more than read. Allowing it lets this one call through; plan mode stays on.'
  }
  if (cause === 'flagged' && verdict?.kind === 'flag') {
    const named = verdict.fired.map(
      ({ rule, probability }) => `“${rule.text}” (${percent(probability)})`,
    )
    return `Flagged by your tool permissions: it looks like it ${named.length === 1 ? 'matches' : 'matches each of'} ${named.join(', ')}.`
  }
  if (cause === 'auto-mode-unavailable' && verdict?.kind === 'unavailable') {
    return `The tool permissions check could not decide (${verdict.reason}), so this is yours to decide.`
  }
  return 'Tool permissions are not set up, so every call is put to you. Set them up from the top bar.'
}

function withBlockedPath(reason: string, blockedPath: string | null): string {
  return blockedPath === null ? reason : `${reason} It was blocked from ${blockedPath}.`
}

/**
 * Composes the prompt for a tool call that auto-mode did not let through. `context`
 * carries whatever the SDK bridge supplied; every field of it is optional and routinely absent.
 */
export function describePermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext = {},
): PermissionPrompt {
  const cause = causeOf(context)
  const verdict = context.verdict

  return {
    title: titleFor(cause, toolName, context.title ?? null),
    subject: subjectOf(toolName, input),
    description: stringField(input, 'description'),
    reason: withBlockedPath(reasonFor(cause, context), context.blockedPath ?? null),
    flagged:
      cause === 'flagged' && verdict?.kind === 'flag'
        ? verdict.fired.map(({ rule, probability }) => ({ text: rule.text, probability }))
        : [],
  }
}
