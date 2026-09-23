import { describe, expect, test } from 'bun:test'
import { createAutoMode } from '../../src/app/autoMode.ts'
import type { AutoModePolicy, AutoModeRule, CallState } from '../../src/core/autoMode.ts'
import type { AutoModeStore, CallJudge } from '../../src/core/ports.ts'

const POLICY: AutoModePolicy = {
  version: 1,
  threshold: 0.3,
  rules: [
    { id: 'sudo', text: 'Runs as root' },
    { id: 'push', text: 'Pushes to a remote' },
  ],
}

function memoryStore(initial: AutoModePolicy | null = null) {
  let stored = initial
  const store: AutoModeStore & { stored: () => AutoModePolicy | null } = {
    load: async () => stored,
    save: async (policy) => {
      stored = policy
    },
    stored: () => stored,
  }
  return store
}

/** Answers from a table keyed by command text; records every call it gets. */
function tableJudge(table: Record<string, Record<string, number>>) {
  const calls: { state: CallState; rules: readonly AutoModeRule[] }[] = []
  const judge: CallJudge = {
    judge: async (state, rules) => {
      calls.push({ state, rules })
      const answers = table[String(state.call.command)] ?? {}
      return new Map(Object.entries(answers))
    },
  }
  return { judge, calls }
}

const where = { cwd: '/repo', home: '/Users/me' }

async function loaded(judge: CallJudge, policy: AutoModePolicy | null = POLICY, timeoutMs = 1_000) {
  const autoMode = createAutoMode({ store: memoryStore(policy), judge, where, timeoutMs })
  await autoMode.load()
  return autoMode
}

describe('createAutoMode', () => {
  test('is off, asking the judge nothing, until a policy exists', async () => {
    const { judge, calls } = tableJudge({})
    const autoMode = await loaded(judge, null)
    expect(await autoMode.verdict('Bash', { command: 'ls' })).toEqual({ kind: 'off' })
    expect(calls).toHaveLength(0)
    expect(autoMode.settings().policy).toBeNull()
  })

  test('allows when every rule answers low, and flags when one answers high', async () => {
    const { judge } = tableJudge({
      ls: { sudo: 0.01, push: 0.02 },
      'git push': { sudo: 0.01, push: 0.95 },
    })
    const autoMode = await loaded(judge)
    expect(await autoMode.verdict('Bash', { command: 'ls' })).toEqual({ kind: 'allow' })
    expect(await autoMode.verdict('Bash', { command: 'git push' })).toMatchObject({
      kind: 'flag',
      fired: [{ rule: { id: 'push' }, probability: 0.95 }],
    })
  })

  test('the judge is asked over the call state, with every rule', async () => {
    const { judge, calls } = tableJudge({ ls: { sudo: 0, push: 0 } })
    const autoMode = await loaded(judge)
    await autoMode.verdict('Bash', { command: 'ls' })
    expect(calls[0]?.state.environment).toEqual({
      repository_root: '/repo',
      home_directory: '/Users/me',
    })
    expect(calls[0]?.rules.map((rule) => rule.id)).toEqual(['sudo', 'push'])
  })

  test('a judge that throws is unavailable, with its reason', async () => {
    const autoMode = await loaded({
      judge: async () => {
        throw new Error('TYPESAFE_API_KEY is not set')
      },
    })
    expect(await autoMode.verdict('Bash', { command: 'ls' })).toEqual({
      kind: 'unavailable',
      reason: 'TYPESAFE_API_KEY is not set',
    })
  })

  test('a judge that never answers is unavailable once the deadline passes', async () => {
    const autoMode = await loaded({ judge: () => new Promise(() => {}) }, POLICY, 20)
    const verdict = await autoMode.verdict('Bash', { command: 'ls' })
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('did not answer')
  })

  test('a repeated call is answered from memory; a failure is never remembered', async () => {
    let fail = true
    let asked = 0
    const autoMode = await loaded({
      judge: async () => {
        asked += 1
        if (fail) throw new Error('down')
        return new Map([
          ['sudo', 0],
          ['push', 0],
        ])
      },
    })
    expect((await autoMode.verdict('Bash', { command: 'bun test' })).kind).toBe('unavailable')
    fail = false
    expect((await autoMode.verdict('Bash', { command: 'bun test' })).kind).toBe('allow')
    expect((await autoMode.verdict('Bash', { command: 'bun test' })).kind).toBe('allow')
    expect(asked).toBe(2)
  })

  test('saving a policy applies to the next call and forgets remembered verdicts', async () => {
    const store = memoryStore(POLICY)
    let asked = 0
    const autoMode = createAutoMode({
      store,
      where,
      timeoutMs: 1_000,
      judge: {
        judge: async (_state, rules) => {
          asked += 1
          return new Map(rules.map((rule) => [rule.id, rule.id === 'rm' ? 0.9 : 0]))
        },
      },
    })
    await autoMode.load()
    expect((await autoMode.verdict('Bash', { command: 'rm x' })).kind).toBe('allow')

    const next: AutoModePolicy = { ...POLICY, rules: [{ id: 'rm', text: 'Deletes files' }] }
    await autoMode.save(next)
    expect(store.stored()).toEqual(next)
    expect(autoMode.settings().policy).toEqual(next)
    expect((await autoMode.verdict('Bash', { command: 'rm x' })).kind).toBe('flag')
    expect(asked).toBe(2)
  })

  test('a policy with no rules allows without asking anyone', async () => {
    const { judge, calls } = tableJudge({})
    const autoMode = await loaded(judge, { version: 1, threshold: 0.3, rules: [] })
    expect(await autoMode.verdict('Bash', { command: 'rm -rf /' })).toEqual({ kind: 'allow' })
    expect(calls).toHaveLength(0)
  })

  test('a trial runs against the policy given, not the saved one, and reports every answer', async () => {
    const { judge } = tableJudge({ 'git push': { push: 0.8 } })
    const autoMode = await loaded(judge, null)
    const trial = await autoMode.trial(
      'Bash',
      { command: 'git push' },
      { version: 1, threshold: 0.3, rules: [{ id: 'push', text: 'Pushes' }] },
    )
    expect(trial.probabilities).toEqual([{ id: 'push', probability: 0.8 }])
    expect(trial.verdict.kind).toBe('flag')
    expect(autoMode.settings().policy).toBeNull()
  })

  test('settings offer the seeds and any migrated statements', async () => {
    const autoMode = createAutoMode({
      store: memoryStore(null),
      judge: tableJudge({}).judge,
      where,
      timeoutMs: 1_000,
      migrated: [{ id: 'legacy-0', text: 'matches rm' }],
    })
    await autoMode.load()
    expect(autoMode.settings().seeds.length).toBeGreaterThan(0)
    expect(autoMode.settings().migrated).toEqual([{ id: 'legacy-0', text: 'matches rm' }])
  })
})
