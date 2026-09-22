import { describe, expect, test } from 'bun:test'
import { describePermissionRequest } from '../../src/core/permissionPrompt.ts'

describe('describePermissionRequest', () => {
  test('a sandbox escape names the command and says why it is being asked', () => {
    const prompt = describePermissionRequest('Bash', {
      command: 'bun install --frozen-lockfile',
      description: 'Install dependencies',
      dangerouslyDisableSandbox: true,
    })

    expect(prompt.title).toBe('Run a command outside the sandbox?')
    expect(prompt.subject).toBe('bun install --frozen-lockfile')
    expect(prompt.description).toBe('Install dependencies')
    expect(prompt.reason).toContain('sandbox')
  })

  test('a sudo command is named as such rather than as a sandbox escape', () => {
    const prompt = describePermissionRequest('Bash', { command: 'sudo rm -rf /tmp/x' })

    expect(prompt.title).toBe('Run a command as root?')
    expect(prompt.subject).toBe('sudo rm -rf /tmp/x')
    expect(prompt.reason).toContain('root')
  })

  test('sudo wins over a sandbox escape when a command is both', () => {
    const prompt = describePermissionRequest('Bash', {
      command: 'sudo make install',
      dangerouslyDisableSandbox: true,
    })

    expect(prompt.title).toBe('Run a command as root?')
  })

  test('a denied Bash command shows the command and blames the deny pattern', () => {
    const prompt = describePermissionRequest('Bash', { command: 'rm -rf build' })

    expect(prompt.subject).toBe('rm -rf build')
    expect(prompt.reason).toContain('deny pattern')
  })

  test('a non-Bash tool falls back to its own name and pulls out its subject', () => {
    expect(describePermissionRequest('WebFetch', { url: 'https://example.com' })).toMatchObject({
      title: 'Allow WebFetch?',
      subject: 'https://example.com',
    })
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

  test("a bridge title never overrides the sandbox escape's own explanation", () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'echo hi', dangerouslyDisableSandbox: true },
      { title: 'Claude wants to run echo hi' },
    )

    expect(prompt.title).toBe('Run a command outside the sandbox?')
  })

  test('a blocked path is surfaced when the bridge reports one', () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'cat /etc/passwd', dangerouslyDisableSandbox: true },
      { blockedPath: '/etc/passwd' },
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

  test('running as root outranks it — the worse fact is the one worth saying', () => {
    const prompt = describePermissionRequest('Bash', { command: 'sudo make install' }, planning)
    expect(prompt.title).toBe('Run a command as root?')
  })

  test('leaving the sandbox outranks it too', () => {
    const prompt = describePermissionRequest(
      'Bash',
      { command: 'ls', dangerouslyDisableSandbox: true },
      planning,
    )
    expect(prompt.title).toBe('Run a command outside the sandbox?')
  })

  test('without the flag it is still a deny pattern, as before', () => {
    const prompt = describePermissionRequest('Bash', { command: 'rm -rf /' }, {})
    expect(prompt.reason).toContain('deny pattern')
  })
})
