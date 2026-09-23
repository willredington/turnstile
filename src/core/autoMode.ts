/**
 * Auto-mode: which tool calls run without asking, decided against the user's own words.
 *
 * The user writes, once, a list of statements saying when a call should be flagged ("pushes to
 * a git remote", "deletes files outside the repository"). For every tool call, each statement
 * becomes one yes/no question — a TypeSafe Noul — over the same description of the call, asked
 * together in one request (`CallJudge`). Each answer is the probability that the call does what
 * the statement describes. **Any** statement at or above the threshold flags the call, and a
 * flagged call goes to the human naming the statement that fired. Otherwise the call runs.
 *
 * One question per statement rather than one question over all of them, because that is the
 * shape the model is calibrated for (one proposition per Noul), and because "any serious
 * violation" is a rule over separate judgments, not one judgment. It is also what lets the
 * prompt say *which* of the user's statements this call ran into.
 *
 * **It fails closed.** A missing answer, an answer that is not a probability, a judge that
 * throws, times out or has no API key — each is `unavailable`, and an unavailable verdict puts
 * the call to the human exactly as a flag does. So does having no policy at all. The one path
 * to running unasked is every statement answering, and every answer being below the threshold.
 *
 * Pure, like the rest of `core`: the judge and the store are ports (`core/ports.ts`), and the
 * session-level wiring that memoizes verdicts and catches failures is `app/autoMode.ts`.
 */

export type AutoModeRule = {
  /** Keys the rule's answer in the judge's response. Never shown to the model. */
  id: string
  /** The user's own statement of when to flag a call, e.g. "Pushes to a git remote". */
  text: string
}

export type AutoModePolicy = {
  version: 1
  rules: AutoModeRule[]
  /** A statement at or above this probability flags the call. */
  threshold: number
}

type FiredRule = { rule: AutoModeRule; probability: number }

export type AutoModeVerdict =
  | { kind: 'allow' }
  | { kind: 'flag'; fired: FiredRule[] }
  /** The judge could not answer. Treated like a flag: the human decides. */
  | { kind: 'unavailable'; reason: string }
  /** Auto-mode has not been set up. Every call is put to the human. */
  | { kind: 'off' }

/**
 * Low on purpose. A Noul near 0.5 is "could be either", and a statement the user wrote down is
 * one they would rather be asked about than not — a false flag costs a click, a missed one runs
 * the thing they said they cared about.
 */
export const DEFAULT_THRESHOLD = 0.3

/** The sensitivity choices the setup screen offers, as thresholds. */
export const SENSITIVITIES = [
  { id: 'strict', label: 'Strict', threshold: 0.15 },
  { id: 'balanced', label: 'Balanced', threshold: DEFAULT_THRESHOLD },
  { id: 'relaxed', label: 'Relaxed', threshold: 0.5 },
] as const

export type SeedRule = AutoModeRule & {
  /** Checked by default on the setup screen. */
  suggested: boolean
}

/**
 * Suggestions offered at setup. `sudo` and the sandbox escape are here, suggested, because they
 * used to be hardcoded prompts: with auto-mode deciding everything, they are statements the
 * user keeps or removes like any other.
 */
export const SEED_RULES: readonly SeedRule[] = [
  {
    id: 'sudo',
    text: 'Runs a command with elevated privileges (sudo, doas, su)',
    suggested: true,
  },
  {
    id: 'sandbox-escape',
    text: 'Asks to run outside the sandbox',
    suggested: true,
  },
  {
    id: 'publish',
    text: 'Pushes, publishes or deploys anything (git push, npm publish, a deploy command)',
    suggested: true,
  },
  {
    id: 'outside-writes',
    text: 'Deletes, moves or overwrites files outside the repository',
    suggested: false,
  },
  {
    id: 'history',
    text: 'Rewrites git history or throws away uncommitted work (reset --hard, push --force, clean, checkout over changes)',
    suggested: false,
  },
  {
    id: 'system-packages',
    text: 'Installs or removes software system-wide (brew, apt, a global npm install)',
    suggested: false,
  },
  {
    id: 'exfiltrate',
    text: 'Sends repository contents, credentials or secrets to a network host',
    suggested: false,
  },
]

/** A JSON value, the shape the judge's state and questions are made of. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type NoulQuestion = {
  type: 'noul'
  instructions: { [key: string]: Json }
  criteria: { true: string; false: string }
}

/** Past this, a command is cut. Long enough for any command a person would read. */
const MAX_SUBJECT_CHARS = 4_000

function truncate(text: string): string {
  return text.length <= MAX_SUBJECT_CHARS
    ? text
    : `${text.slice(0, MAX_SUBJECT_CHARS)} … [truncated]`
}

export type CallState = {
  call: { [key: string]: Json }
  environment: { repository_root: string; home_directory: string }
}

/**
 * What every question is asked over: the call, and where it runs. The repository root and home
 * directory are there so a statement like "outside the repository" has something to be judged
 * against.
 */
export function callState(
  toolName: string,
  input: Record<string, unknown>,
  where: { cwd: string; home: string },
): CallState {
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : null
  const description = typeof input.description === 'string' ? input.description : null

  const call: { [key: string]: Json } = { tool: toolName }
  if (command !== null) call.command = truncate(command)
  else call.input = truncate(JSON.stringify(input))
  if (description !== null && description !== '') call.description = truncate(description)
  call.runs_outside_sandbox = input.dangerouslyDisableSandbox === true

  return {
    call,
    environment: { repository_root: where.cwd, home_directory: where.home },
  }
}

/**
 * The one question a statement becomes. It asks what the call would *do*, not whether its text
 * mentions the statement's words — `grep sudo` does not run anything as root.
 */
export function questionFor(rule: AutoModeRule): NoulQuestion {
  return {
    type: 'noul',
    instructions: {
      task: 'A coding agent wants to make the tool call in `call`. Would making it do what `flag_when` describes?',
      flag_when: rule.text,
      how_to_judge:
        'Judge what the call would actually do when run, in `environment`. For a shell command, `call.command` is the command itself; for any other tool, `call.input` is its arguments. Mentioning a word is not doing it.',
    },
    criteria: {
      true: 'Running this call would do what `flag_when` describes.',
      false: 'Running this call would not do what `flag_when` describes.',
    },
  }
}

/**
 * The verdict from the judge's answers. Every rule must have an answer that is a probability;
 * anything less is `unavailable` rather than a partial allow, because the rule without an
 * answer is exactly the one nobody checked.
 */
export function decide(
  probabilities: ReadonlyMap<string, number>,
  policy: AutoModePolicy,
): AutoModeVerdict {
  const fired: FiredRule[] = []
  for (const rule of policy.rules) {
    const probability = probabilities.get(rule.id)
    if (
      probability === undefined ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return { kind: 'unavailable', reason: `no usable answer for “${rule.text}”` }
    }
    if (probability >= policy.threshold) fired.push({ rule, probability })
  }
  if (fired.length === 0) return { kind: 'allow' }
  return { kind: 'flag', fired: fired.sort((a, b) => b.probability - a.probability) }
}

/**
 * A policy from untrusted JSON (the file on disk, a request body), or null when it is not one.
 * Rule text is trimmed and empty rules dropped, since an empty statement asks nothing.
 */
export function parsePolicy(raw: unknown): AutoModePolicy | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { rules, threshold } = raw as Record<string, unknown>
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) return null
  if (!Array.isArray(rules)) return null

  const parsed: AutoModeRule[] = []
  const ids = new Set<string>()
  for (const entry of rules) {
    if (typeof entry !== 'object' || entry === null) return null
    const { id, text } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || typeof text !== 'string') return null
    if (ids.has(id)) return null
    ids.add(id)
    const trimmed = text.trim()
    if (trimmed !== '') parsed.push({ id, text: trimmed })
  }
  return { version: 1, rules: parsed, threshold }
}

/**
 * `toolPermissions.denyPatterns` from before auto-mode, as statements the setup screen fills in
 * for the user to reword. Nothing is migrated silently: a regex is not a sentence, and the user
 * is the one who knows what it was for.
 */
export function legacyRules(patterns: readonly string[]): AutoModeRule[] {
  return patterns.map((pattern, index) => ({
    id: `legacy-${index}`,
    text: `Runs a command or tool matching the regular expression \`${pattern}\``,
  }))
}

/** What the setup screen is built from (`GET /auto-mode`). */
export type AutoModeSettings = {
  /** Null until the user has set auto-mode up; every call prompts until then. */
  policy: AutoModePolicy | null
  seeds: readonly SeedRule[]
  /** Statements recovered from a pre-auto-mode `denyPatterns` config, offered for rewording. */
  migrated: AutoModeRule[]
}

/** A dry run from the setup screen's "Try a command" box: each rule's answer, and the verdict. */
export type AutoModeTrial = {
  verdict: AutoModeVerdict
  probabilities: { id: string; probability: number }[]
}
