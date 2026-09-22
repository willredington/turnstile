/**
 * Decides which tool calls the agent-sdk client can auto-allow without blocking on a human.
 *
 * The Claude Code CLI, run on its own, never prompts for an ordinary `git status` or `cat`:
 * it has its own built-in read-only detection. That detection disappears the moment a
 * consumer supplies a `canUseTool` callback (as `adapters/agent-sdk/client.ts` must, to gate
 * tool calls at all) — the SDK routes every non-disallowed tool call through the consumer's
 * callback instead, with no fallback to any built-in list. Without this module, that means
 * Turnstile would prompt for everything, always.
 *
 * This is a denylist, not an allowlist: every tool call auto-approves by default — every MCP
 * tool, `WebFetch`, `Task`, any Bash command — except a tiny hardcoded floor (`sudo`, via
 * `containsSudoInvocation`, which survives with zero user config) and whatever the user adds
 * to `toolPermissions.denyPatterns` in config. A deny pattern matches the full Bash command
 * text when the tool is `Bash`, and the tool name for everything else — so a user can write
 * `rm -rf` to deny that specific shape of command, or `^mcp__some-server__` to deny a whole
 * MCP server, while leaving everything else auto-approved.
 *
 * Deliberately the opposite bias from the allowlist this replaced: a hole here costs nothing
 * by design, since the user explicitly chose to trade the old safety margin (every unrecognized
 * tool call costs a prompt) for fewer interruptions, denying only what they name.
 *
 * **Plan mode is the exception, and it is at the bottom of this file.** `isReadOnlyCall` is an
 * allowlist, because the bias above is wrong for a mode whose entire promise is that nothing
 * changed. Both live here so the two rules cannot drift apart or be reasoned about separately.
 */

const STAGE_SEPARATOR = /&&|\|\||;|\|/

function splitEnvPrefix(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) {
    i += 1
  }
  return tokens.slice(i)
}

/**
 * True when `sudo` is invoked as a command in any `&&`/`||`/`;`/`|`-separated stage of a
 * (possibly compound) Bash command — the one hardcoded denial that survives with zero user
 * config. Splitting on those operators is not full shell parsing and can be fooled by one
 * hidden inside quotes, the same tolerance the allowlist this replaced always accepted.
 */
export function containsSudoInvocation(command: string): boolean {
  return command.split(STAGE_SEPARATOR).some((stage) => {
    const tokens = splitEnvPrefix(stage.trim().split(/\s+/).filter(Boolean))
    return tokens[0] === 'sudo'
  })
}

/**
 * Compiles `toolPermissions.denyPatterns` config strings into `RegExp`s. Schema validation
 * (`ToolPermissionsConfigSchema`) already guarantees these compile when they came through
 * `loadConfig` — this throws anyway, rather than silently dropping a bad pattern, as a second,
 * independent fail-closed layer for any caller that builds `AgentSdkClientOptions` directly
 * (a test, or a future non-file config source) without going through that schema. A
 * silently-skipped deny pattern is a security-relevant hole, not a cosmetic bug, so this must
 * not degrade gracefully.
 */
export function compileDenyPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern)
    } catch (cause) {
      throw new Error(
        `toolPermissions.denyPatterns[${index}] (${pattern}) is not a valid regular expression`,
        { cause },
      )
    }
  })
}

/**
 * Whether a tool call can be auto-allowed without asking a human — the gate `canUseTool`
 * checks before it ever surfaces a prompt. `denyPatterns` are matched against the full command
 * text for `Bash` calls, and the tool name for everything else. A `Bash` call with a missing or
 * non-string `command` (never happens from the real SDK) falls back to matching patterns
 * against the literal tool name `'Bash'` rather than skipping matching altogether, but skips
 * the sudo check since there's no command text to inspect.
 */
export function isAutoApprovedTool(
  toolName: string,
  input: Record<string, unknown>,
  denyPatterns: readonly RegExp[] = [],
): boolean {
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : null

  if (command !== null && containsSudoInvocation(command)) return false

  const subject = command ?? toolName
  if (denyPatterns.some((pattern) => pattern.test(subject))) return false

  return true
}

/**
 * The first of `reserved` that a tool call's input names, or null.
 *
 * What keeps the review independent of the work it reviews: Turnstile's rules live outside the
 * checkout, and its own state inside `.turnstile/`, and the coding agent is refused any tool call
 * — a Read, a Grep, a Bash command, the write tool — whose input mentions either. Matched against
 * the whole serialized input rather than per-tool fields, so a new tool or an unusual argument
 * name cannot route around it.
 *
 * A speed bump, not a sandbox: a command that names neither (`grep -r` from `/`, say) can still
 * read what it reaches. It stops the agent stumbling on the rules and reading them outright,
 * which is the case that matters.
 */
export function reservedPathIn(
  input: Record<string, unknown>,
  reserved: readonly string[],
): string | null {
  const text = JSON.stringify(input)
  return reserved.find((marker) => marker !== '' && text.includes(marker)) ?? null
}

/**
 * Tools that only ever read, and so are safe while the agent is restricted to planning.
 *
 * `Task` is deliberately absent. A subagent's own tool calls are not known to come back through
 * this gate — `session.ts` already assumes they do not, and treats a finished `Task` as a
 * possible edit — so approving one here would approve everything it goes on to do.
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'NotebookRead',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
])

/**
 * Shell commands that only read.
 *
 * Small on purpose. Everything left out costs one prompt during planning, and everything
 * wrongly left in is a silent write — the two mistakes are not the same size, so this errs at
 * the side that only costs a click. `awk` and `xargs` are absent for that reason: both can
 * write without a shell redirect for `isReadOnlyCommand` to see.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'bat',
  'head',
  'tail',
  'wc',
  'nl',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'find',
  'fd',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'command',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'rev',
  'comm',
  'join',
  'diff',
  'cmp',
  'jq',
  'yq',
  'sed',
  'git',
  'date',
  'env',
  'true',
  'false',
])

/** `git` subcommands that only read. Everything else — `add`, `commit`, `checkout`, `stash`,
 *  `config`, `apply`, `clean`, `worktree` — changes the tree, the index or the config. */
const READ_ONLY_GIT = new Set([
  'log',
  'diff',
  'show',
  'status',
  'blame',
  'grep',
  'describe',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'rev-parse',
  'rev-list',
  'shortlog',
  'show-ref',
  'symbolic-ref',
  'name-rev',
  'whatchanged',
  'count-objects',
])

/** `find` actions that do something rather than report something. */
const FIND_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
])

/**
 * Git's global flags that take a separate value, whose value must not be mistaken for the
 * subcommand — `git -C /repo log` is a log, not a `/repo`.
 */
const GIT_FLAGS_WITH_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The subcommand in `git`'s arguments, past any global flags. Null when there is none. */
function gitSubcommand(args: readonly string[]): string | null {
  let at = 0
  while (at < args.length) {
    const token = args[at] ?? ''
    if (!token.startsWith('-')) return token
    // A flag spelled `--git-dir=/x` carries its value; `-C /x` takes the next token.
    at += GIT_FLAGS_WITH_VALUES.has(token) ? 2 : 1
  }
  return null
}

/** The command itself, without the path it was invoked by: `/usr/bin/git` is still `git`. */
function commandName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

function stageIsReadOnly(stage: string): boolean {
  const tokens = splitEnvPrefix(stage.trim().split(/\s+/).filter(Boolean))
  const first = tokens[0]
  // An empty stage is punctuation, not a command — `a | ` never runs anything.
  if (first === undefined) return true

  const name = commandName(first)
  if (!READ_ONLY_COMMANDS.has(name)) return false

  // `sed -i` edits in place, and the flag can hide in a bundle (`-ni`) or spell itself out.
  if (name === 'sed') {
    return !tokens.some(
      (token) =>
        token === '--in-place' ||
        token.startsWith('--in-place=') ||
        (/^-[^-]/.test(token) && token.includes('i')),
    )
  }
  if (name === 'find') return !tokens.some((token) => FIND_ACTIONS.has(token))
  if (name === 'git') return READ_ONLY_GIT.has(gitSubcommand(tokens.slice(1)) ?? '')
  return true
}

/**
 * Whether a Bash command only reads.
 *
 * Every `&&`/`||`/`;`/`|`-separated stage has to be read-only on its own, because a pipeline is
 * only as harmless as its most destructive stage.
 *
 * Redirection and command substitution disqualify a command outright, whatever it runs:
 * `cat a > b` writes, and `$(…)` can hide anything at all. Every `>` is treated as a redirect
 * without checking whether it is quoted — a `grep` for a literal `>` therefore costs a prompt,
 * which is the correct direction to be wrong in.
 *
 * This is text matching, not shell parsing, and it can be fooled the same way
 * `containsSudoInvocation` can — by an operator hidden inside quotes. It is a gate in front of
 * a human, not a sandbox: everything it declines is still offered to the reader to allow.
 */
function isReadOnlyCommand(command: string): boolean {
  if (command.includes('>')) return false
  if (command.includes('`') || command.includes('$(')) return false
  return command.split(STAGE_SEPARATOR).every(stageIsReadOnly)
}

/**
 * Whether a tool call changes nothing, and so may run while the agent is restricted to planning.
 *
 * **This is an allowlist, and that is a deliberate inversion** of the denylist the rest of this
 * module is built on. The bias there — auto-approve unless the user named it — is the right one
 * for ordinary work, where the cost of a hole is a review that catches the edit anyway. Plan
 * mode has no such backstop: its whole promise is that nothing changed while you were reading
 * the plan, and a promise kept by a denylist is kept only against the writes somebody thought
 * to name. The user turning plan mode on is asking for the stricter bias, for as long as it is
 * on.
 *
 * Declining is not denying. A call that fails this goes to the human with plan mode given as
 * the reason, so a build or an install during planning stays possible and stays visible.
 */
export function isReadOnlyCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : null
    // A Bash call with no command text is not something to vouch for.
    return command !== null && isReadOnlyCommand(command)
  }
  return READ_ONLY_TOOLS.has(toolName)
}
