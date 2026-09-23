import { describe, expect, test } from 'bun:test'
import type { AutoModeVerdict } from '../../src/core/autoMode.ts'
import { describePermissionRequest } from '../../src/core/permissionPrompt.ts'

const flagged: AutoModeVerdict = {
  kind: 'flag',
  fired: [
    { rule: { id: 'push', text: 'Pushes to a remote' }, probability: 0.91 },
    { rule: { id: 'history', text: 'Rewrites git history' }, probability: 0.42 },
  ],
}

describe('describePermissionRequest', () => {
  test('a flagged command is quoted, and names every statement it ran into', () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'git push --force', description: 'Force push' },
      { verdict: flagged },
    )

    expect(prompt.title).toBe('Run this command?')
    expect(prompt.subject).toBe('git push --force')
    expect(prompt.description).toBe('Force push')
    expect(prompt.reason).toContain('“Pushes to a remote” (91%)')
    expect(prompt.reason).toContain('“Rewrites git history” (42%)')
    expect(prompt.flagged).toEqual([
      { text: 'Pushes to a remote', probability: 0.91 },
      { text: 'Rewrites git history', probability: 0.42 },
    ])
  })

  test('an unavailable judge says why, and lists nothing as flagged', () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'ls' },
      { verdict: { kind: 'unavailable', reason: 'TYPESAFE_API_KEY is not set' } },
    )
    expect(prompt.reason).toContain('TYPESAFE_API_KEY is not set')
    expect(prompt.flagged).toEqual([])
  })

  test('with auto-mode off, it says so and where to turn it on', () => {
    for (const context of [{}, { verdict: { kind: 'off' } as const }]) {
      const prompt = describePermissionRequest('Bash', { command: 'ls' }, context)
      expect(prompt.reason).toContain('not set up')
    }
  })

  test('a non-Bash tool falls back to its own name and pulls out its subject', () => {
    expect(
      describePermissionRequest('WebFetch', { url: 'https://example.com' }, { verdict: flagged }),
    ).toMatchObject({ title: 'Allow WebFetch?', subject: 'https://example.com' })
    expect(describePermissionRequest('Read', { file_path: '/etc/hosts' })).toMatchObject({
      title: 'Allow Read?',
      subject: '/etc/hosts',
    })
  })

  test('a bridge-supplied title is preferred over the generic fallback', () => {
    const prompt = describePermissionRequest(
      'Grep',
      { pattern: 'TODO' },
      { title: 'Claude wants to search for TODO' },
    )
    expect(prompt.title).toBe('Claude wants to search for TODO')
  })

  test('a blocked path is surfaced when the bridge reports one', () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'cat /etc/passwd', dangerouslyDisableSandbox: true },
      { blockedPath: '/etc/passwd', verdict: flagged },
    )
    expect(prompt.reason).toContain('/etc/passwd')
  })

  test('an input with nothing quotable leaves subject null rather than inventing one', () => {
    expect(describePermissionRequest('SomeTool', {}).subject).toBeNull()
    expect(describePermissionRequest('Bash', {}).subject).toBeNull()
  })

  test('the model description is dropped when it is not a string', () => {
    const prompt = describePermissionRequest('Bash', { command: 'ls', description: 42 })
    expect(prompt.description).toBeNull()
  })
})

/**
 * Plan mode as a reason.
 *
 * Worth its own sentence because it is the surprising one: it is temporary, the reader turned
 * it on themselves, and it is the answer to "why is it asking me about a command it ran without
 * asking an hour ago".
 */
describe('a call stopped by plan mode', () => {
  const planning = { planRestricted: true }

  test('says what it is actually asking', () => {
    const prompt = describePermissionRequest('Bash', { command: 'npm install' }, planning)
    expect(prompt.title).toBe('Let the agent do this while planning?')
    expect(prompt.subject).toBe('npm install')
    expect(prompt.reason).toContain('read and plan only')
  })

  test('says that allowing it does not turn plan mode off', () => {
    const prompt = describePermissionRequest('Bash', { command: 'npm install' }, planning)
    expect(prompt.reason).toContain('plan mode stays on')
  })
})
