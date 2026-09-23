import { describe, expect, test } from 'bun:test'
import {
  type AutoModePolicy,
  callState,
  DEFAULT_THRESHOLD,
  decide,
  legacyRules,
  parsePolicy,
  questionFor,
  SEED_RULES,
} from '../../src/core/autoMode.ts'

const policy = (threshold = 0.3): AutoModePolicy => ({
  version: 1,
  threshold,
  rules: [
    { id: 'sudo', text: 'Runs a command with elevated privileges' },
    { id: 'push', text: 'Pushes to a git remote' },
  ],
})

describe('decide', () => {
  test('allows when every rule is below the threshold', () => {
    const verdict = decide(
      new Map([
        ['sudo', 0.05],
        ['push', 0.29],
      ]),
      policy(),
    )
    expect(verdict).toEqual({ kind: 'allow' })
  })

  test('flags at the threshold, naming every rule that fired, most likely first', () => {
    const verdict = decide(
      new Map([
        ['sudo', 0.3],
        ['push', 0.9],
      ]),
      policy(),
    )
    expect(verdict).toEqual({
      kind: 'flag',
      fired: [
        { rule: { id: 'push', text: 'Pushes to a git remote' }, probability: 0.9 },
        { rule: { id: 'sudo', text: 'Runs a command with elevated privileges' }, probability: 0.3 },
      ],
    })
  })

  test('one rule firing is enough', () => {
    const verdict = decide(
      new Map([
        ['sudo', 0.01],
        ['push', 0.7],
      ]),
      policy(),
    )
    expect(verdict.kind).toBe('flag')
  })

  test('a missing answer is unavailable, never an allow', () => {
    const verdict = decide(new Map([['sudo', 0.01]]), policy())
    expect(verdict).toMatchObject({ kind: 'unavailable' })
  })

  test('a non-numeric or out-of-range answer is unavailable', () => {
    expect(
      decide(
        new Map([
          ['sudo', Number.NaN],
          ['push', 0],
        ]),
        policy(),
      ).kind,
    ).toBe('unavailable')
    expect(
      decide(
        new Map([
          ['sudo', 1.5],
          ['push', 0],
        ]),
        policy(),
      ).kind,
    ).toBe('unavailable')
  })

  test('a policy with no rules allows everything', () => {
    expect(decide(new Map(), { version: 1, threshold: 0.3, rules: [] })).toEqual({ kind: 'allow' })
  })
})

describe('callState', () => {
  const where = { cwd: '/repo', home: '/Users/me' }

  test('a Bash call carries its command, description and sandbox flag', () => {
    expect(
      callState(
        'Bash',
        { command: 'git push', description: 'Push it', dangerouslyDisableSandbox: true },
        where,
      ),
    ).toEqual({
      call: {
        tool: 'Bash',
        command: 'git push',
        description: 'Push it',
        runs_outside_sandbox: true,
      },
      environment: { repository_root: '/repo', home_directory: '/Users/me' },
    })
  })

  test('any other tool carries its input as JSON', () => {
    const state = callState('Read', { file_path: '/repo/a.ts' }, where)
    expect(state.call).toEqual({
      tool: 'Read',
      input: '{"file_path":"/repo/a.ts"}',
      runs_outside_sandbox: false,
    })
  })

  test('a very long command is truncated, and says so', () => {
    const state = callState('Bash', { command: 'x'.repeat(10_000) }, where)
    const command = state.call.command as string
    expect(command.length).toBeLessThan(5_000)
    expect(command).toContain('[truncated]')
  })
})

describe('questionFor', () => {
  test('is a noul question naming the rule', () => {
    const question = questionFor({ id: 'push', text: 'Pushes to a git remote' })
    expect(question.type).toBe('noul')
    expect(JSON.stringify(question.instructions)).toContain('Pushes to a git remote')
    expect(question.criteria?.true).toBeDefined()
    expect(question.criteria?.false).toBeDefined()
  })
})

describe('parsePolicy', () => {
  test('accepts a well-formed policy', () => {
    expect(parsePolicy(policy())).toEqual(policy())
  })

  test('trims rule text and drops empty rules', () => {
    const parsed = parsePolicy({
      version: 1,
      threshold: 0.5,
      rules: [
        { id: 'a', text: '  Pushes  ' },
        { id: 'b', text: '   ' },
      ],
    })
    expect(parsed?.rules).toEqual([{ id: 'a', text: 'Pushes' }])
  })

  test('rejects a threshold outside (0, 1], duplicate ids, or the wrong shape', () => {
    expect(parsePolicy({ ...policy(), threshold: 0 })).toBeNull()
    expect(parsePolicy({ ...policy(), threshold: 1.2 })).toBeNull()
    expect(
      parsePolicy({
        version: 1,
        threshold: 0.3,
        rules: [
          { id: 'a', text: 'x' },
          { id: 'a', text: 'y' },
        ],
      }),
    ).toBeNull()
    expect(parsePolicy({ rules: 'nope' })).toBeNull()
    expect(parsePolicy(null)).toBeNull()
  })
})

describe('seeds and migration', () => {
  test('seed ids are unique, and sudo is among them', () => {
    const ids = SEED_RULES.map((seed) => seed.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('sudo')
    expect(DEFAULT_THRESHOLD).toBe(0.3)
  })

  test('legacy deny patterns become editable statements quoting the pattern', () => {
    expect(legacyRules(['rm -rf', '^WebFetch$'])).toEqual([
      { id: 'legacy-0', text: 'Runs a command or tool matching the regular expression `rm -rf`' },
      {
        id: 'legacy-1',
        text: 'Runs a command or tool matching the regular expression `^WebFetch$`',
      },
    ])
  })
})
