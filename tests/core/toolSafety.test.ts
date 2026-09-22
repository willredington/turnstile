import { describe, expect, test } from 'bun:test'
import {
  compileDenyPatterns,
  containsSudoInvocation,
  isAutoApprovedTool,
  isReadOnlyCall,
  reservedPathIn,
} from '../../src/core/toolSafety.ts'

describe('containsSudoInvocation', () => {
  test('a leading sudo is caught', () => {
    expect(containsSudoInvocation('sudo cat /etc/shadow')).toBe(true)
    expect(containsSudoInvocation('sudo rm -rf /')).toBe(true)
  })

  test('sudo in a later stage of a compound command is caught', () => {
    expect(containsSudoInvocation('git status && sudo rm -rf /')).toBe(true)
    expect(containsSudoInvocation('echo hi; sudo reboot')).toBe(true)
    expect(containsSudoInvocation('cat file | sudo tee /etc/hosts')).toBe(true)
    expect(containsSudoInvocation('false || sudo whoami')).toBe(true)
  })

  test('an env-prefixed sudo is still caught', () => {
    expect(containsSudoInvocation('FOO=bar sudo cat /etc/shadow')).toBe(true)
  })

  test('commands the old allowlist would have blocked are no longer caught by the floor', () => {
    expect(containsSudoInvocation('rm -rf /tmp/x')).toBe(false)
    expect(containsSudoInvocation('git push')).toBe(false)
    expect(containsSudoInvocation('docker run -it ubuntu')).toBe(false)
    expect(containsSudoInvocation('git status')).toBe(false)
  })
})

describe('compileDenyPatterns', () => {
  test('valid patterns compile', () => {
    const compiled = compileDenyPatterns(['^Bash$', 'rm -rf'])
    expect(compiled).toHaveLength(2)
    expect(compiled[0]?.source).toBe('^Bash$')
    expect(compiled[1]?.source).toBe('rm -rf')
  })

  test('an empty list compiles to an empty list', () => {
    expect(compileDenyPatterns([])).toEqual([])
  })

  test('an invalid pattern throws, naming the pattern and its index', () => {
    expect(() => compileDenyPatterns(['(unterminated'])).toThrow(
      /toolPermissions\.denyPatterns\[0\] \(\(unterminated\)/,
    )
  })
})

describe('isAutoApprovedTool', () => {
  test('sudo is denied with no config at all', () => {
    expect(isAutoApprovedTool('Bash', { command: 'sudo rm -rf /' })).toBe(false)
  })

  test('everything else is auto-approved by default, with no config', () => {
    expect(isAutoApprovedTool('Bash', { command: 'rm -rf /tmp/x' })).toBe(true)
    expect(isAutoApprovedTool('Bash', { command: 'git push' })).toBe(true)
    expect(isAutoApprovedTool('Bash', { command: 'docker run -it ubuntu' })).toBe(true)
    expect(isAutoApprovedTool('mcp__plugin_claude-mem_mcp-search__get_observations', {})).toBe(true)
    expect(isAutoApprovedTool('WebFetch', { url: 'https://example.com' })).toBe(true)
    expect(isAutoApprovedTool('Task', {})).toBe(true)
  })

  test('a Bash deny pattern matches the command text', () => {
    const denyRmRf = [/rm -rf/]
    expect(isAutoApprovedTool('Bash', { command: 'rm -rf /' }, denyRmRf)).toBe(false)
    expect(isAutoApprovedTool('Bash', { command: 'git status' }, denyRmRf)).toBe(true)
  })

  test('a non-Bash deny pattern matches the tool name', () => {
    const denyMcpSearch = [/^mcp__plugin_claude-mem_mcp-search__/]
    expect(
      isAutoApprovedTool('mcp__plugin_claude-mem_mcp-search__get_observations', {}, denyMcpSearch),
    ).toBe(false)
    expect(isAutoApprovedTool('WebFetch', { url: 'https://example.com' }, denyMcpSearch)).toBe(true)
  })

  test('a tool-name pattern does not match Bash command text, and vice versa', () => {
    // Shaped like a Bash command, but as a tool-name pattern it must not reach into `input`.
    const bashShapedPattern = [/^rm -rf$/]
    expect(isAutoApprovedTool('Bash', { command: 'rm -rf /' }, bashShapedPattern)).toBe(true)

    // Shaped like a tool name, but for Bash the subject is the command text, not 'Bash'.
    const toolNameShapedPattern = [/^Bash$/]
    expect(isAutoApprovedTool('Bash', { command: 'git status' }, toolNameShapedPattern)).toBe(true)
  })

  test('a missing or non-string Bash command matches patterns against the literal tool name', () => {
    expect(isAutoApprovedTool('Bash', {}, [/^Bash$/])).toBe(false)
    expect(isAutoApprovedTool('Bash', { command: 42 }, [/^Bash$/])).toBe(false)
    expect(isAutoApprovedTool('Bash', {})).toBe(true)
  })
})

describe('reservedPathIn', () => {
  test('finds a reserved path anywhere in the input', () => {
    expect(reservedPathIn({ command: 'ls ~/.turnstile/rules' }, ['.turnstile'])).toBe('.turnstile')
    expect(reservedPathIn({ nested: { paths: ['/shared/rules/a.md'] } }, ['/shared/rules'])).toBe(
      '/shared/rules',
    )
  })

  test('null when nothing reserved is named', () => {
    expect(reservedPathIn({ command: 'git status' }, ['.turnstile'])).toBeNull()
    expect(reservedPathIn({ command: 'anything' }, [''])).toBeNull()
  })
})

/**
 * What may run while the agent is restricted to planning.
 *
 * Plan mode used to check the write tool and nothing else, so `propose_edit` was refused while
 * `cat > file` went through without a word. These are the tests for the gate that closed that,
 * and they are deliberately adversarial: the interesting cases are the ones that read
 * harmlessly and are not.
 */
describe('what only reads', () => {
  const bash = (command: string) => isReadOnlyCall('Bash', { command })

  test('the commands planning actually needs are silent', () => {
    for (const command of [
      'ls -la src',
      'cat src/core/types.ts',
      'rg "planMode" src',
      'git log --oneline -20',
      'git diff HEAD~1',
      'git status',
      'find . -name "*.ts"',
      'sed -n "1,50p" README.md',
      'head -40 package.json | jq .name',
      'wc -l src/**/*.ts',
      'NODE_ENV=test rg foo',
      '/usr/bin/git show HEAD',
    ]) {
      expect(bash(command)).toBe(true)
    }
  })

  test('a redirect is a write, whatever is doing it', () => {
    // The exact shape that got past plan mode before.
    expect(bash('cat > src/thing.ts')).toBe(false)
    expect(bash('echo hi >> notes.md')).toBe(false)
    expect(bash("cat <<'EOF' > plan.md")).toBe(false)
  })

  test('editing in place is a write however the flag is spelled', () => {
    expect(bash('sed -i "s/a/b/" file.ts')).toBe(false)
    expect(bash('sed -i.bak "s/a/b/" file.ts')).toBe(false)
    expect(bash('sed --in-place "s/a/b/" file.ts')).toBe(false)
    expect(bash('sed -ni "s/a/b/p" file.ts')).toBe(false)
  })

  test('command substitution could hide anything, so it disqualifies', () => {
    expect(bash('echo $(rm -rf src)')).toBe(false)
    expect(bash('echo `rm -rf src`')).toBe(false)
  })

  test('a pipeline is only as harmless as its worst stage', () => {
    expect(bash('cat file | tee other')).toBe(false)
    expect(bash('ls && npm install')).toBe(false)
    expect(bash('git log; git commit -am wip')).toBe(false)
    expect(bash('rg foo | xargs rm')).toBe(false)
  })

  test('git is read-only by subcommand, not by name', () => {
    expect(bash('git commit -am "wip"')).toBe(false)
    expect(bash('git checkout -- .')).toBe(false)
    expect(bash('git stash')).toBe(false)
    expect(bash('git config user.name x')).toBe(false)
    expect(bash('git apply patch.diff')).toBe(false)
    expect(bash('git clean -fd')).toBe(false)
    // A global flag's value is not the subcommand.
    expect(bash('git -C /repo log')).toBe(true)
    expect(bash('git -c core.pager=cat log')).toBe(true)
    expect(bash('git -C /repo commit -am x')).toBe(false)
    expect(bash('git')).toBe(false)
  })

  test('find that acts rather than reports is a write', () => {
    expect(bash('find . -name "*.tmp" -delete')).toBe(false)
    expect(bash('find . -name "*.ts" -exec rm {} ;')).toBe(false)
  })

  test('anything not recognised is not vouched for', () => {
    expect(bash('npm install')).toBe(false)
    expect(bash('python script.py')).toBe(false)
    expect(bash("node -e \"require('fs').writeFileSync('x','y')\"")).toBe(false)
    expect(bash('./build.sh')).toBe(false)
    expect(bash('mv a b')).toBe(false)
  })

  test('a Bash call with no command text is not vouched for', () => {
    expect(isReadOnlyCall('Bash', {})).toBe(false)
  })

  test('reading tools pass and writing ones do not', () => {
    expect(isReadOnlyCall('Read', { file_path: 'a.ts' })).toBe(true)
    expect(isReadOnlyCall('Grep', { pattern: 'x' })).toBe(true)
    expect(isReadOnlyCall('WebFetch', { url: 'https://example.com' })).toBe(true)
    expect(isReadOnlyCall('NotebookEdit', {})).toBe(false)
    expect(isReadOnlyCall('mcp__other__write', {})).toBe(false)
  })

  test('a subagent is not vouched for, because its own calls are not gated here', () => {
    // `session.ts` already treats a finished `Task` as a possible edit. Approving the Task here
    // would be approving everything it goes on to do.
    expect(isReadOnlyCall('Task', { description: 'explore' })).toBe(false)
  })
})
