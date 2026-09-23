import { generateText, isStepCount, type LanguageModel } from 'ai'
import type { AskConfig } from '../../core/config.ts'
import type { Asker } from '../../core/ports.ts'
import { runTelemetry } from './client.ts'
import { ASK_SYSTEM_PROMPT } from './prompts.ts'
import { readOnlyTools } from './tools.ts'

/**
 * One answer per question, from a model with read-only tools.
 *
 * No terminal tool and no schema — an answer is prose, and forcing it through a tool call would
 * buy nothing a plain response does not already give. It stops on the step cap alone, and the
 * cap step may not call a tool, so a run that spends its whole budget looking around still
 * answers with what it found rather than throwing away the work.
 *
 * Read-only: `readOnlyTools` is all it is offered, so there is no write path to disable.
 */
/** Said on the cap step, where no more looking is possible. */
const ANSWER_NOW =
  'You are out of tool calls. Answer the question now, from what you have already read. ' +
  'If that is not enough to be sure, say what you found and what you could not check.'

export function createModelAsker(model: LanguageModel, config: AskConfig): Asker {
  return {
    ask: async ({ payload, reader, root }) => {
      // One deadline across both attempts, rather than a fresh timeout per try. Someone is
      // watching this, and a retry that turns a 60-second wait into a 120-second one is worse than
      // the failure it is trying to paper over. A transient error still gets its second go.
      const deadline = AbortSignal.timeout(config.timeoutMs)

      const attempt = async (): Promise<string> => {
        const result = await generateText({
          model,
          system: ASK_SYSTEM_PROMPT,
          prompt: payload,
          tools: readOnlyTools(reader, root),
          stopWhen: [isStepCount(config.maxSteps)],
          // The cap step may not call a tool, so answering is all it can do. Without this a model
          // still searching spends that step on one more grep and the run ends with nothing to
          // say. `toolChoice`, not `activeTools: []`: the tools stay defined, because Gemini
          // refuses (or ignores) a request whose history calls tools it no longer declares. And
          // said in words as well, because Gemini also ignores `toolChoice: 'none'` — both
          // observed live.
          prepareStep: ({ stepNumber, messages }) =>
            stepNumber >= config.maxSteps - 1
              ? {
                  toolChoice: 'none' as const,
                  messages: [...messages, { role: 'user' as const, content: ANSWER_NOW }],
                }
              : {},
          abortSignal: deadline,
          telemetry: runTelemetry('turnstile.ask'),
        })

        // The LAST step's text, not `result.text`. A model that narrates while it works ("now
        // let me check the callers…") emits that text alongside its tool calls, and depending
        // on the provider that chatter lands in the aggregate — observed live, as a preamble
        // of "Perfect. Now I have the answer." above the real one. The reader wants the
        // answer, not the working.
        const answer = (result.steps.at(-1)?.text ?? result.text).trim()
        // A run that spent every step on tool calls and never said anything is a failure the
        // reader has to be told about — silence would read as a broken feature.
        // Says how the run ended, since that is the only clue the reader (and the trace) gets.
        if (answer === '') {
          const steps = result.steps.length
          throw new Error(
            `The model finished without answering, after ${steps} step${steps === 1 ? '' : 's'} ` +
              `(finish reason: ${result.finishReason}).`,
          )
        }
        return answer
      }

      try {
        return await attempt()
      } catch (error) {
        if (deadline.aborted) throw error
        return await attempt()
      }
    },
  }
}
