import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileRuleSource,
  expandHome,
  MAX_CONTEXT_CHARS,
  rulesDirFor,
} from '../../src/adapters/fs/rules.ts'
import { defaultRulesDir } from '../../src/core/rules.ts'

/**
 * Rules come from a directory outside the checkout; context docs from the checkout itself. `home`
 * is a temp directory here, so nothing touches the real `~/.turnstile`.
 */

let root: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'turnstile-rules-root-'))
  home = await mkdtemp(join(tmpdir(), 'turnstile-rules-home-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const rulesDir = () => defaultRulesDir(home, root)

const ruleYaml = (rule: string, extra = '') => `description: ${rule} rule\nrule: ${rule}\n${extra}`

describe('createFileRuleSource', () => {
  test('nothing configured is no rules, no context and nothing to warn about', async () => {
    expect(await createFileRuleSource({ home }).load(root)).toEqual({
      rules: [],
      context: [],
      warnings: [],
    })
  })

  test('loads every rule from the rules directory, nested ones and .yml included', async () => {
    await Bun.write(join(rulesDir(), 'a.yaml'), ruleYaml('A', 'globs: [src/**]\nseverity: high\n'))
    await Bun.write(join(rulesDir(), 'api/b.yml'), ruleYaml('B'))
    await Bun.write(join(rulesDir(), 'notes.txt'), 'not a rule')

    const { rules, warnings } = await createFileRuleSource({ home }).load(root)
    expect(rules.map((rule) => [rule.name, rule.path, rule.rule])).toEqual([
      ['a', 'a.yaml', 'A'],
      ['b', 'api/b.yml', 'B'],
    ])
    expect(rules[0]).toMatchObject({ globs: ['src/**'], severity: 'high' })
    expect(warnings).toEqual([])
  })

  test('reads a block-scalar rule the way it is written', async () => {
    await Bun.write(
      join(rulesDir(), 'long.yaml'),
      'description: Long\nrule: |\n  First line.\n  Second line.\n',
    )
    const { rules } = await createFileRuleSource({ home }).load(root)
    expect(rules[0]?.rule).toBe('First line.\nSecond line.')
  })

  /** One bad file costs that rule, never every other rule — and is said, never silent. */
  test('skips a file that is not valid YAML or not a valid rule, and says which', async () => {
    await Bun.write(join(rulesDir(), 'good.yaml'), ruleYaml('G'))
    await Bun.write(join(rulesDir(), 'broken.yaml'), 'description: [unclosed\n')
    await Bun.write(join(rulesDir(), 'typo.yaml'), ruleYaml('T', 'severtiy: high\n'))

    const { rules, warnings } = await createFileRuleSource({ home }).load(root)
    expect(rules.map((rule) => rule.name)).toEqual(['good'])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('broken.yaml')
    expect(warnings[1]).toContain('typo.yaml')
    expect(warnings[1]).toContain('severtiy')
  })

  /** The old format is not read any more; a rule left in it must not quietly stop applying. */
  test('warns about Markdown rules left from the old format', async () => {
    await Bun.write(join(rulesDir(), 'old.md'), '---\nglobs: src/**\n---\nA')
    await Bun.write(join(rulesDir(), 'api/older.mdc'), 'B')

    const { rules, warnings } = await createFileRuleSource({ home }).load(root)
    expect(rules).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('api/older.mdc')
    expect(warnings[1]).toContain('old.md')
    expect(warnings[1]).toContain('YAML')
  })

  /** The old location is inside the checkout, where the coding agent can read it. */
  test('ignores rules left in the checkout', async () => {
    await Bun.write(join(root, '.turnstile/rules/a.yaml'), ruleYaml('A'))
    expect((await createFileRuleSource({ home }).load(root)).rules).toEqual([])
  })

  test('a configured rulesDir replaces the default, ~ expanded', async () => {
    await Bun.write(join(home, 'team-rules/shared.yaml'), ruleYaml('S'))
    await Bun.write(join(rulesDir(), 'default.yaml'), ruleYaml('D'))
    const { rules } = await createFileRuleSource({ home, rulesDir: '~/team-rules' }).load(root)
    expect(rules.map((rule) => rule.name)).toEqual(['shared'])
  })

  test('finds CLAUDE.md and AGENTS.md at any depth, but not in ignored or vendored trees', async () => {
    await Bun.write(join(root, '.gitignore'), 'build/\n')
    await Bun.write(join(root, 'CLAUDE.md'), 'root')
    await Bun.write(join(root, 'src/AGENTS.md'), 'src')
    await Bun.write(join(root, 'build/CLAUDE.md'), 'ignored')
    await Bun.write(join(root, 'node_modules/pkg/CLAUDE.md'), 'vendored')

    const { context } = await createFileRuleSource({ home }).load(root)
    expect(context).toEqual([
      { path: 'CLAUDE.md', body: 'root' },
      { path: 'src/AGENTS.md', body: 'src' },
    ])
  })

  test('cuts an oversized context doc', async () => {
    await Bun.write(join(root, 'CLAUDE.md'), 'x'.repeat(MAX_CONTEXT_CHARS + 10))
    const { context } = await createFileRuleSource({ home }).load(root)
    expect(context[0]?.body.endsWith('… (truncated)')).toBe(true)
  })

  test('never follows a rule symlinked out of the rules directory', async () => {
    await Bun.write(join(home, 'secret.yaml'), ruleYaml('secret'))
    await Bun.write(join(rulesDir(), '.keep'), '')
    await symlink(join(home, 'secret.yaml'), join(rulesDir(), 'leak.yaml'))
    const { rules } = await createFileRuleSource({ home }).load(root)
    expect(rules.map((rule) => rule.rule)).not.toContain('secret')
  })
})

describe('rulesDirFor', () => {
  test('the default, unless config names one', () => {
    expect(rulesDirFor('/r', { home: '/h' })).toBe('/h/.turnstile/rules/-r')
    expect(rulesDirFor('/r', { home: '/h', rulesDir: '/abs' })).toBe('/abs')
    expect(expandHome('~/x', '/h')).toBe('/h/x')
  })
})
