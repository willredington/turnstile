import { type Fetch, TypeSafeClient } from '@typesafe-ai/sdk'
import { questionFor } from '../../core/autoMode.ts'
import type { CallJudge } from '../../core/ports.ts'

/**
 * Auto-mode's judge: one TypeSafe System One request per tool call, with one Noul question per
 * statement, keyed by the statement's id. Each answer is the probability that the call does
 * what the statement describes.
 *
 * One request, not one per statement: questions over the same state run in parallel on the
 * server, so a policy of seven statements costs about what a policy of one does.
 *
 * It does not catch anything. A missing key, a refused request or a malformed answer throws,
 * and `app/autoMode.ts` turns every throw into "ask the human".
 */

export type TypeSafeJudgeOptions = {
  apiKey: string
  /** A System One model, e.g. `jev-latest`. */
  model: string
  /** Per attempt. The caller bounds the whole verdict separately. */
  timeoutMs: number
  /** For tests. Defaults to the global `fetch`. */
  fetch?: Fetch
}

export function createTypeSafeJudge(options: TypeSafeJudgeOptions): CallJudge {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: options.model,
    timeout: options.timeoutMs,
    // One retry: the agent is waiting, and the caller's deadline would cut a second one short.
    retry: { maxRetries: 1 },
    logLevel: 'off',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })

  return {
    judge: async (state, rules, signal) => {
      const questions = Object.fromEntries(rules.map((rule) => [rule.id, questionFor(rule)]))
      const result = await client.systemOne(
        { state, questions },
        signal === undefined ? {} : { signal },
      )

      const answers = new Map<string, number>()
      for (const rule of rules) {
        const answer = (result.answers as Record<string, { type?: string; noul?: unknown }>)[
          rule.id
        ]
        if (answer?.type === 'noul' && typeof answer.noul === 'number') {
          answers.set(rule.id, answer.noul)
        }
      }
      return answers
    },
  }
}
