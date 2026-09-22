import { describe, expect, test } from 'bun:test'
import { type Rule, ruleFrom } from '../../src/core/rules.ts'
import { findingsFromVerdicts, type Verdicts, verdictSchema } from '../../src/core/verdicts.ts'

function rule(name: string, data: Record<string, unknown> = {}): Rule {
  const result = ruleFrom(`${name}.yaml`, { description: `${name} says so`, rule: name, ...data })
  if ('error' in result) throw new Error(result.error)
  return result.rule
}

const OPEN = rule('open')
const FIXED = rule('fixed', { severity: 'high' })
const RULES = [OPEN, FIXED]

type Verdict = Verdicts['verdicts'][number]

const kept = (name: string): Verdict => ({
  rule: name,
  violated: false,
  severity: null,
  locations: [],
})

const at = (path: string, startLine: number, endLine = startLine) => ({ path, startLine, endLine })

function findings(verdicts: Verdict[]) {
  const result = findingsFromVerdicts(RULES, { verdicts })
  if ('error' in result) throw new Error(result.error)
  return result.findings
}

function refusal(verdicts: Verdict[]): string {
  const result = findingsFromVerdicts(RULES, { verdicts })
  if ('findings' in result) throw new Error('expected the verdicts to be refused')
  return result.error
}

describe('findingsFromVerdicts', () => {
  test('every rule kept is no findings', () => {
    expect(findings([kept('open'), kept('fixed')])).toEqual([])
  })

  test("a broken rule is a finding per location, in the rule's own words", () => {
    const result = findings([
      { rule: 'open', violated: true, severity: 'medium', locations: [at('src/a.ts', 3, 5)] },
      kept('fixed'),
    ])
    expect(result).toEqual([
      {
        path: 'src/a.ts',
        startLine: 3,
        endLine: 5,
        severity: 'medium',
        rule: 'open',
        message: 'open says so',
      },
    ])
  })

  /** A caller the change broke is where the rule is broken — another file is a location like any. */
  test('a location in another file passes through', () => {
    const result = findings([
      {
        rule: 'open',
        violated: true,
        severity: 'high',
        locations: [at('src/a.ts', 2), at('tests/a.test.ts', 14)],
      },
      kept('fixed'),
    ])
    expect(result.map((f) => `${f.path}:${f.startLine}`)).toEqual([
      'src/a.ts:2',
      'tests/a.test.ts:14',
    ])
  })

  test("the author's severity wins over the reviewer's, which may then be null", () => {
    const result = findings([
      kept('open'),
      { rule: 'fixed', violated: true, severity: 'low', locations: [at('a.ts', 1)] },
    ])
    expect(result[0]?.severity).toBe('high')
    expect(
      findings([
        kept('open'),
        { rule: 'fixed', violated: true, severity: null, locations: [at('a.ts', 1)] },
      ])[0]?.severity,
    ).toBe('high')
  })

  test("a kept rule's locations and severity are ignored", () => {
    expect(
      findings([
        { rule: 'open', violated: false, severity: 'high', locations: [at('a.ts', 1)] },
        kept('fixed'),
      ]),
    ).toEqual([])
  })

  describe('refuses, naming what to fix', () => {
    test('a rule with no verdict', () => {
      expect(refusal([kept('open')])).toContain('missing a verdict for: fixed')
    })

    test('a rule with two', () => {
      expect(refusal([kept('open'), kept('open'), kept('fixed')])).toContain(
        'more than one verdict for: open',
      )
    })

    test('a rule that does not govern this file', () => {
      expect(refusal([kept('open'), kept('fixed'), kept('invented')])).toContain(
        'no such rule: invented',
      )
    })

    test('a broken rule with nowhere to point', () => {
      expect(
        refusal([{ rule: 'open', violated: true, severity: 'low', locations: [] }, kept('fixed')]),
      ).toContain('open is violated but has no locations')
    })

    test('a broken rule with no severity, when its author left it open', () => {
      expect(
        refusal([
          { rule: 'open', violated: true, severity: null, locations: [at('a.ts', 1)] },
          kept('fixed'),
        ]),
      ).toContain('open is violated but has no severity')
    })

    test('a location that ends before it starts', () => {
      expect(
        refusal([
          { rule: 'open', violated: true, severity: 'low', locations: [at('a.ts', 9, 3)] },
          kept('fixed'),
        ]),
      ).toContain('endLine is before startLine')
    })

    test('every problem at once, so one correction can fix them all', () => {
      const error = refusal([{ rule: 'open', violated: true, severity: null, locations: [] }])
      expect(error).toContain('missing a verdict for: fixed')
      expect(error).toContain('no severity')
      expect(error).toContain('no locations')
    })
  })
})

describe('verdictSchema', () => {
  test('holds the rule names to the ones governing the file', () => {
    const schema = verdictSchema(['open', 'fixed'])
    expect(schema.safeParse({ verdicts: [kept('open')] }).success).toBe(true)
    expect(schema.safeParse({ verdicts: [kept('invented')] }).success).toBe(false)
  })

  test('refuses a severity outside low, medium and high', () => {
    const schema = verdictSchema(['open'])
    const verdict = { ...kept('open'), violated: true, severity: 'critical' }
    expect(schema.safeParse({ verdicts: [verdict] }).success).toBe(false)
  })
})
