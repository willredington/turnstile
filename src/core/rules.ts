import { z } from 'zod'
import { matchesGlob } from './riskbar.ts'
import type { Severity } from './types.ts'

/**
 * Review rules: what this repository considers kosher, written down as checks a change either
 * passes or breaks.
 *
 * A rule is one YAML file in the repository's rules directory — OUTSIDE the checkout, by default
 * `~/.turnstile/rules/<repository path, dashed>/` (`defaultRulesDir`). Outside on purpose: the
 * review is an independent assessment of the coding agent's work, and a rule the agent can `cat`
 * is one it can write to, or around. (`agent-sdk/client.ts` also denies the agent any tool call
 * naming a reserved path — see `core/toolSafety.ts`'s `reservedPathIn`.) The file's stem is the
 * rule's name:
 *
 *     # validate-request-bodies.yaml
 *     description: Request bodies are parsed with parseBody
 *     globs: [src/handlers/**\/*.ts]
 *     severity: high
 *     rule: |
 *       A handler that accepts a request body takes it as `unknown` and checks it with
 *       `parseBody` before reading any field.
 *     violates: Reads a field off an unchecked body, or casts it (`body as Foo`).
 *     complies: The body is `unknown` and goes through parseBody first.
 *
 * The reviewer returns one typed verdict per rule — broken or not, and how badly
 * (`core/verdicts.ts`). `rule` is what it judges, `violates`/`complies` say what counts either
 * way, and `severity` — when the author fixes it — replaces the reviewer's own judgment of how
 * bad a violation is.
 *
 * Validation is pure and lives here; finding and parsing the files is `adapters/fs/rules.ts`.
 */

const SEVERITIES = ['low', 'medium', 'high'] as const satisfies readonly Severity[]

/**
 * One rule file's contents. Strict, so a misspelled key is an error rather than a field that
 * silently never applies.
 */
const RuleFileSchema = z
  .object({
    /** One line: what the rule asks for. Also the finding's message. */
    description: z.string().trim().min(1),
    /** Which files it governs. Absent or empty means every file. */
    globs: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((globs) =>
        globs === undefined ? [] : typeof globs === 'string' ? [globs] : globs,
      ),
    /** How bad breaking it is. Absent: the model judges each violation. */
    severity: z.enum(SEVERITIES).optional(),
    /** The rule itself, as the reviewer is asked it. */
    rule: z.string().trim().min(1),
    /** What counts as breaking it. */
    violates: z.string().trim().min(1).optional(),
    /** What counts as keeping it. */
    complies: z.string().trim().min(1).optional(),
  })
  .strict()

export type Rule = {
  /** The file's stem — what a finding cites. */
  name: string
  /** Relative to the rules directory. */
  path: string
  description: string
  globs: string[]
  severity?: Severity
  rule: string
  violates?: string
  complies?: string
}

/**
 * Something the repository already wrote down for its coder — `CLAUDE.md`, `AGENTS.md`. Given to
 * the reviewer as background, to tell what is normal here. Never a rule: nothing is judged
 * against it.
 */
export type ContextDoc = {
  path: string
  body: string
}

/**
 * Where a repository's rules live when config names no `review.rulesDir`: under the user's home,
 * keyed by the repository's absolute path with every non-alphanumeric character dashed — the
 * same scheme Claude Code uses for `~/.claude/projects/`, so the directory is findable by eye.
 */
export function defaultRulesDir(home: string, root: string): string {
  return `${home.replace(/\/+$/, '')}/.turnstile/rules/${root.replace(/[^A-Za-z0-9]/g, '-')}`
}

/** The stem of a path: `rules/api/no-default-exports.yaml` → `no-default-exports`. */
function stemOf(path: string): string {
  const base = path.split('/').at(-1) ?? path
  return base.replace(/\.ya?ml$/i, '')
}

/**
 * A parsed rule file as a `Rule`, or why it is not one. `data` is whatever the YAML parsed to;
 * an error names the field at fault, so a warning can say what to fix.
 */
export function ruleFrom(path: string, data: unknown): { rule: Rule } | { error: string } {
  const parsed = RuleFileSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    )
    return { error: issues.join('; ') }
  }
  const { description, globs, severity, rule, violates, complies } = parsed.data
  return {
    rule: {
      name: stemOf(path),
      path,
      description,
      globs,
      ...(severity === undefined ? {} : { severity }),
      rule,
      ...(violates === undefined ? {} : { violates }),
      ...(complies === undefined ? {} : { complies }),
    },
  }
}

/** The rules governing one file: every unscoped rule, and every rule a glob of which matches. */
export function rulesFor(path: string, rules: readonly Rule[]): Rule[] {
  return rules.filter(
    (rule) => rule.globs.length === 0 || rule.globs.some((glob) => matchesGlob(path, glob)),
  )
}

/**
 * The context docs that apply to one file: the repository root's, then each ancestor
 * directory's, nearest last — the same way Claude Code layers nested `CLAUDE.md` files.
 */
export function contextFor(path: string, context: readonly ContextDoc[]): ContextDoc[] {
  const directories = new Set([''])
  const parts = path.split('/').slice(0, -1)
  for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/'))

  const dirOf = (docPath: string): string => docPath.split('/').slice(0, -1).join('/')
  return context
    .filter((doc) => directories.has(dirOf(doc.path)))
    .sort((a, b) => dirOf(a.path).length - dirOf(b.path).length)
}
