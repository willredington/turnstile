import { homedir } from 'node:os'
import { globby } from 'globby'
import type { RuleSource } from '../../core/ports.ts'
import { type ContextDoc, defaultRulesDir, type Rule, ruleFrom } from '../../core/rules.ts'
import { readInside } from './safePath.ts'

/**
 * The repository's review rules, from its rules directory OUTSIDE the checkout (see
 * `core/rules.ts`): one YAML file per rule, parsed here and validated in core. And the context
 * docs it already has for its coder (`CLAUDE.md`, `AGENTS.md`, at the root or in any directory —
 * those are the coder's own, so they stay in the checkout).
 *
 * Read fresh on every review pass. It is a handful of small files, and reading them each time is
 * what lets a rule edit take effect on the next pass with nothing watching the filesystem.
 */

const CONTEXT_NAMES = ['CLAUDE.md', 'AGENTS.md']

/** Past this, a context doc is cut — it is background, and a huge one would crowd out the file. */
export const MAX_CONTEXT_CHARS = 20_000

/** `~/x` → `<home>/x`; anything else unchanged. */
export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

/**
 * The rules directory for `root`: `rulesDir` from config when set, else the default under
 * `home`.
 */
export function rulesDirFor(root: string, options: { rulesDir?: string; home?: string }): string {
  const home = options.home ?? homedir()
  return options.rulesDir === undefined
    ? defaultRulesDir(home, root)
    : expandHome(options.rulesDir, home)
}

const listed = (dir: string, patterns: string[]) =>
  globby(patterns, { cwd: dir, dot: true, onlyFiles: true, followSymbolicLinks: false }).catch(
    () => [] as string[],
  )

export function createFileRuleSource(
  options: { rulesDir?: string; home?: string } = {},
): RuleSource {
  return {
    load: async (root) => {
      const dir = rulesDirFor(root, options)
      const [rulePaths, legacyPaths, contextPaths] = await Promise.all([
        listed(dir, ['**/*.{yaml,yml}']),
        listed(dir, ['**/*.{md,mdc}']),
        globby(
          CONTEXT_NAMES.map((name) => `**/${name}`),
          {
            cwd: root,
            gitignore: true,
            onlyFiles: true,
            ignore: ['**/.git', '**/node_modules'],
            followSymbolicLinks: false,
          },
        ).catch(() => [] as string[]),
      ])

      const rules: Rule[] = []
      const warnings: string[] = []
      for (const path of rulePaths.sort()) {
        const text = await readInside(dir, path)
        if (text === null) continue
        let data: unknown
        try {
          data = Bun.YAML.parse(text)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          warnings.push(`Rule ${path} is skipped: not valid YAML (${reason})`)
          continue
        }
        const result = ruleFrom(path, data)
        if ('rule' in result) rules.push(result.rule)
        else warnings.push(`Rule ${path} is skipped: ${result.error}`)
      }

      for (const path of legacyPaths.sort()) {
        warnings.push(
          `Rule ${path} is skipped: rules are YAML now — convert it to a .yaml file (see the README)`,
        )
      }

      const context: ContextDoc[] = []
      for (const path of contextPaths.sort()) {
        const text = await readInside(root, path)
        if (text === null) continue
        const body =
          text.length > MAX_CONTEXT_CHARS
            ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… (truncated)`
            : text
        context.push({ path, body })
      }

      return { rules, context, warnings }
    },
  }
}
