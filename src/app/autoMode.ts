import {
  type AutoModePolicy,
  type AutoModeRule,
  type AutoModeTrial,
  type AutoModeVerdict,
  callState,
  decide,
  SEED_RULES,
} from '../core/autoMode.ts'
import type { AutoModeControl, AutoModeStore, CallJudge } from '../core/ports.ts'

/**
 * Auto-mode for a running app: the user's policy, held in memory and saved through the store,
 * and a verdict for every tool call the agent connection asks about.
 *
 * What this adds over `core/autoMode.ts`'s `decide` is everything that can go wrong on the way
 * to an answer. A judge that throws (no API key, a network error, a refused request) or takes
 * longer than `timeoutMs` becomes `unavailable`, never an allow — the agent is blocked while
 * this runs, and a verdict that never arrives is a turn that never ends.
 *
 * Verdicts are remembered per call, because an agent runs the same `bun test` a dozen times a
 * turn and each one is a round trip it waits on. Only answers are remembered: a failure is
 * retried next time, since whatever made it fail may have passed. Saving a policy forgets
 * everything, since every remembered answer was to questions that may no longer be asked.
 */

export type AutoModeDeps = {
  store: AutoModeStore
  judge: CallJudge
  /** Where calls run, so a statement about "outside the repository" can be judged. */
  where: { cwd: string; home: string }
  /** The whole budget for one verdict, retries included. */
  timeoutMs: number
  /** Statements recovered from an old `denyPatterns` config, for the setup screen. */
  migrated?: AutoModeRule[]
}

/** Enough for every distinct call in a long session; the oldest is dropped past it. */
const MEMO_LIMIT = 500

export type AutoMode = AutoModeControl & {
  /** Reads the saved policy. Until this resolves, auto-mode is off and every call prompts. */
  load(): Promise<void>
}

export function createAutoMode(deps: AutoModeDeps): AutoMode {
  let policy: AutoModePolicy | null = null
  const memo = new Map<string, AutoModeVerdict>()

  /** Asks the judge within the deadline. Throws on any failure, with a sentence saying why. */
  const ask = async (
    toolName: string,
    input: Record<string, unknown>,
    rules: readonly AutoModeRule[],
    signal: AbortSignal | undefined,
  ): Promise<Map<string, number>> => {
    const deadline = AbortSignal.timeout(deps.timeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const state = callState(toolName, input, deps.where)

    // Raced as well as signalled: a judge that ignores its signal must still not hold the agent.
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the judge did not answer within ${deps.timeoutMs} ms`)),
        deps.timeoutMs,
      )
    })
    try {
      return await Promise.race([deps.judge.judge(state, rules, combined), expired])
    } finally {
      clearTimeout(timer)
    }
  }

  const reasonOf = (error: unknown): string =>
    error instanceof Error && error.message !== '' ? error.message : String(error)

  return {
    load: async () => {
      policy = await deps.store.load()
    },

    settings: () => ({ policy, seeds: SEED_RULES, migrated: deps.migrated ?? [] }),

    save: async (next) => {
      await deps.store.save(next)
      policy = next
      memo.clear()
    },

    verdict: async (toolName, input, signal) => {
      const current = policy
      if (current === null) return { kind: 'off' }
      if (current.rules.length === 0) return { kind: 'allow' }

      const key = JSON.stringify([toolName, input])
      const remembered = memo.get(key)
      if (remembered !== undefined) return remembered

      let verdict: AutoModeVerdict
      try {
        verdict = decide(await ask(toolName, input, current.rules, signal), current)
      } catch (error) {
        return { kind: 'unavailable', reason: reasonOf(error) }
      }
      // Saved while this was being answered: the answer is to the old questions. Use it for
      // this call, which asked them, and remember nothing.
      if (policy !== current) return verdict
      if (verdict.kind === 'unavailable') return verdict

      memo.set(key, verdict)
      if (memo.size > MEMO_LIMIT) {
        const oldest = memo.keys().next().value
        if (oldest !== undefined) memo.delete(oldest)
      }
      return verdict
    },

    trial: async (toolName, input, candidate): Promise<AutoModeTrial> => {
      if (candidate.rules.length === 0) return { verdict: { kind: 'allow' }, probabilities: [] }
      try {
        const answers = await ask(toolName, input, candidate.rules, undefined)
        return {
          verdict: decide(answers, candidate),
          probabilities: candidate.rules.flatMap((rule) => {
            const probability = answers.get(rule.id)
            return probability === undefined ? [] : [{ id: rule.id, probability }]
          }),
        }
      } catch (error) {
        return { verdict: { kind: 'unavailable', reason: reasonOf(error) }, probabilities: [] }
      }
    },
  }
}
