import { z } from 'zod'
import type { Rule } from './rules.ts'
import type { Finding, Severity } from './types.ts'

/**
 * The reviewer's answer, typed: one verdict per rule that governs the file — broken or not, how
 * badly, and where.
 *
 * A rule's outcome is a boolean and a severity, so that is all the reviewer returns. It writes
 * nothing: a finding's message is the rule's own `description`, and the only part of a finding
 * that is the reviewer's is the judgment, and where it applies. Where can be any file — a caller
 * the change broke is a location in the caller.
 *
 * The schema holds the shape (and, through an enum, the rule names); `findingsFromVerdicts` holds
 * what a schema cannot say: that every rule was answered exactly once, and that a broken rule
 * says where and how badly. Its errors are written for the reviewer to read and correct, since
 * the submit tool hands them back mid-run.
 */

const SEVERITIES = ['low', 'medium', 'high'] as const satisfies readonly Severity[]

const LocationSchema = z.object({
  path: z.string().min(1).describe('Relative to the repository root.'),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
})

/** The submission for a file governed by `ruleNames` — which must not be empty. */
export function verdictSchema(ruleNames: readonly [string, ...string[]]) {
  return z.object({
    verdicts: z.array(
      z.object({
        rule: z.enum(ruleNames),
        violated: z.boolean(),
        severity: z
          .enum(SEVERITIES)
          .nullable()
          .describe('How bad the violation is. Null when the rule is kept.'),
        locations: z
          .array(LocationSchema)
          .describe(
            'Where the change breaks it: new-file line numbers, in this file or any other. ' +
              'Empty when the rule is kept.',
          ),
      }),
    ),
  })
}

export type Verdicts = z.infer<ReturnType<typeof verdictSchema>>

/**
 * The findings a complete, consistent set of verdicts adds up to — or what is wrong with it.
 *
 * One finding per location of each broken rule, at the rule's own severity when its author fixed
 * one, else the reviewer's. A kept rule contributes nothing, whatever else its verdict says.
 */
export function findingsFromVerdicts(
  rules: readonly Rule[],
  { verdicts }: Verdicts,
): { findings: Finding[] } | { error: string } {
  const problems: string[] = []
  const byRule = new Map<string, Verdicts['verdicts'][number]>()
  const duplicated = new Set<string>()
  for (const verdict of verdicts) {
    if (byRule.has(verdict.rule)) duplicated.add(verdict.rule)
    byRule.set(verdict.rule, verdict)
  }

  const known = new Set(rules.map((rule) => rule.name))
  const unknown = verdicts.map((v) => v.rule).filter((name) => !known.has(name))
  const missing = rules.map((rule) => rule.name).filter((name) => !byRule.has(name))
  if (missing.length > 0) problems.push(`missing a verdict for: ${missing.join(', ')}`)
  if (duplicated.size > 0) problems.push(`more than one verdict for: ${[...duplicated].join(', ')}`)
  if (unknown.length > 0) problems.push(`no such rule: ${unknown.join(', ')}`)

  const findings: Finding[] = []
  for (const rule of rules) {
    const verdict = byRule.get(rule.name)
    if (verdict === undefined || !verdict.violated) continue

    const severity = rule.severity ?? verdict.severity
    if (severity === null) problems.push(`${rule.name} is violated but has no severity`)
    if (verdict.locations.length === 0) {
      problems.push(`${rule.name} is violated but has no locations`)
    }
    for (const location of verdict.locations) {
      if (location.endLine < location.startLine) {
        problems.push(`${rule.name}: endLine is before startLine at ${location.path}`)
        continue
      }
      if (severity === null) continue
      findings.push({ ...location, severity, rule: rule.name, message: rule.description })
    }
  }

  if (problems.length > 0) return { error: `Not accepted — ${problems.join('; ')}.` }
  return { findings }
}
