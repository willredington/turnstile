/**
 * The two deterministic rules about tool calls that sit in front of auto-mode.
 *
 * Whether an ordinary call runs without asking is auto-mode's to decide, against the user's own
 * statements (`core/autoMode.ts`). What is left here is what no statement should be able to
 * change:
 *
 * - `reservedPathIn`: Turnstile's own state is refused outright, never put to anyone.
 * - `isReadOnlyCall`: while plan mode is on, only calls that read may run unasked. An
 *   allowlist, because plan mode's whole promise is that nothing changed.
 *
 * Both are text matching over tool input, not sandboxes. They are gates in front of a human.
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
 * The first of `reserved` that a tool call's input names, or null.
 *
 * What keeps Turnstile's own state — `.turnstile/` in the checkout, and `~/.turnstile` — out of
 * the agent's hands: it is refused any tool call — a Read, a Grep, a Bash command, the write
 * tool — whose input mentions either. Matched against
 * the whole serialized input rather than per-tool fields, so a new tool or an unusual argument
 * name cannot route around it.
 *
 * A speed bump, not a sandbox: a command that names neither (`grep -r` from `/`, say) can still
 * read what it reaches. It stops the agent stumbling on the state directory and reading or
 * rewriting it outright, which is the case that matters.
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
 * This is text matching, not shell parsing, and it can be fooled by an operator
 * hidden inside quotes. It is a gate in front of
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
 * **This is an allowlist.** Auto-mode flags what the user's statements describe; plan mode has
 * nothing like that to lean on — its whole promise is that nothing changed while you were
 * reading the plan, and a promise kept by naming the bad cases is kept only against the ones
 * somebody thought to name. The user turning plan mode on is asking for the stricter bias, for
 * as long as it is on.
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
