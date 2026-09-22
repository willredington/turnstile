import { describe, expect, test } from 'bun:test'
import { contextFor, defaultRulesDir, type Rule, ruleFrom, rulesFor } from '../../src/core/rules.ts'

/** The rule, or the test fails saying why it was refused. */
function valid(path: string, data: unknown): Rule {
  const result = ruleFrom(path, data)
  if ('error' in result) throw new Error(result.error)
  return result.rule
}

function refusal(data: unknown): string {
  const result = ruleFrom('r.yaml', data)
  if ('rule' in result) throw new Error('expected the rule to be refused')
  return result.error
}

describe('ruleFrom', () => {
  test('reads every field, named after the file', () => {
    expect(
      valid('api/validate-bodies.yaml', {
        description: 'Request bodies are parsed with parseBody',
        globs: ['src/handlers/**/*.ts'],
        severity: 'high',
        rule: 'Parse the body with parseBody before reading it.',
        violates: 'Reads a field off an unchecked body.',
        complies: 'The body goes through parseBody first.',
      }),
    ).toEqual({
      name: 'validate-bodies',
      path: 'api/validate-bodies.yaml',
      description: 'Request bodies are parsed with parseBody',
      globs: ['src/handlers/**/*.ts'],
      severity: 'high',
      rule: 'Parse the body with parseBody before reading it.',
      violates: 'Reads a field off an unchecked body.',
      complies: 'The body goes through parseBody first.',
    })
  })

  test('needs only a description and the rule; the rest is optional', () => {
    const rule = valid('no-console.yml', { description: 'No console', rule: 'Do not log.' })
    expect(rule).toEqual({
      name: 'no-console',
      path: 'no-console.yml',
      description: 'No console',
      globs: [],
      rule: 'Do not log.',
    })
    // Absent, not undefined-valued: a field that is not there is not part of the question.
    expect('severity' in rule).toBe(false)
    expect('violates' in rule).toBe(false)
  })

  test('takes one glob as a string', () => {
    expect(valid('r.yaml', { description: 'd', rule: 'r', globs: 'src/**' }).globs).toEqual([
      'src/**',
    ])
  })

  test('refuses a missing rule or description, naming the field', () => {
    expect(refusal({ description: 'd' })).toContain('rule')
    expect(refusal({ rule: 'r' })).toContain('description')
    expect(refusal({ description: '   ', rule: 'r' })).toContain('description')
  })

  test('refuses a severity that is not low, medium or high', () => {
    expect(refusal({ description: 'd', rule: 'r', severity: 'critical' })).toContain('severity')
    expect(refusal({ description: 'd', rule: 'r', severity: 'none' })).toContain('severity')
  })

  /** A misspelled key would otherwise be a part of the rule that silently never applies. */
  test('refuses an unknown key', () => {
    expect(refusal({ description: 'd', rule: 'r', violation: 'x' })).toContain('violation')
  })

  test('refuses a file that is not a mapping at all', () => {
    expect(refusal('just prose')).not.toBe('')
    expect(refusal(null)).not.toBe('')
  })
})

describe('rulesFor', () => {
  const rules = [
    valid('ts.yaml', { description: 'd', rule: 'ts', globs: 'src/**/*.ts' }),
    valid('py.yaml', { description: 'd', rule: 'py', globs: ['**/*.py'] }),
    valid('all.yaml', { description: 'd', rule: 'everything' }),
  ]

  test('matches by glob, and a rule with no globs governs every file', () => {
    expect(rulesFor('src/app/a.ts', rules).map((rule) => rule.name)).toEqual(['ts', 'all'])
    expect(rulesFor('tools/x.py', rules).map((rule) => rule.name)).toEqual(['py', 'all'])
    expect(rulesFor('README.md', rules).map((rule) => rule.name)).toEqual(['all'])
  })
})

describe('contextFor', () => {
  const docs = [
    { path: 'src/app/CLAUDE.md', body: 'app' },
    { path: 'CLAUDE.md', body: 'root' },
    { path: 'lib/AGENTS.md', body: 'lib' },
    { path: 'src/CLAUDE.md', body: 'src' },
  ]

  /** The same layering Claude Code applies to nested CLAUDE.md files: outermost first. */
  test("returns the root's and every ancestor directory's, nearest last", () => {
    expect(contextFor('src/app/a.ts', docs).map((doc) => doc.body)).toEqual(['root', 'src', 'app'])
    expect(contextFor('README.md', docs).map((doc) => doc.body)).toEqual(['root'])
  })
})

describe('defaultRulesDir', () => {
  /** Outside the checkout, where the coding agent does not stumble on it. */
  test('lives under home, keyed by the repository path with non-alphanumerics dashed', () => {
    expect(defaultRulesDir('/Users/me/', '/Users/me/projects/my.app')).toBe(
      '/Users/me/.turnstile/rules/-Users-me-projects-my-app',
    )
  })
})
