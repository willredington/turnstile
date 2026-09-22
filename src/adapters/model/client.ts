import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelConfig } from '../../core/config.ts'

/**
 * Mirrors the fields of OpenRouterChatSettings we set. Kept as our own type so model
 * resolution stays testable without constructing a real provider.
 */
type ModelSettings = {
  models?: string[]
  provider?: ModelConfig['provider']
  temperature?: number
}

type ResolvedModel = {
  /** Passed as the first argument to openrouter.chat(). */
  primaryModel: string
  settings: ModelSettings
}

function resolveModel(config: ModelConfig): ResolvedModel {
  const primaryModel = config.models[0]
  if (primaryModel === undefined) throw new Error('model.models is empty')

  const settings: ModelSettings = { models: config.models, temperature: config.temperature }
  if (config.provider !== undefined) settings.provider = config.provider

  return { primaryModel, settings }
}

/**
 * Resolves one `ModelConfig` into one `LanguageModel` instance. Generic on purpose: the
 * author's model, the risk check's model, and the risk advisor's model are three separate
 * configs, each resolved through this same function, so each can be tuned (and swapped)
 * independently rather than being locked to whatever the author is using.
 */
export function createModel(apiKey: string, config: ModelConfig): LanguageModel {
  const openrouter = createOpenRouter({ apiKey })
  const resolved = resolveModel(config)
  return openrouter.chat(resolved.primaryModel, resolved.settings)
}

export function readApiKey(env: NodeJS.ProcessEnv, variable: string): string {
  const key = env[variable]
  if (key === undefined || key.trim() === '') {
    throw new Error(
      `${variable} is not set. Turnstile needs an OpenRouter key to review a file or answer a question about one.`,
    )
  }
  return key
}

/**
 * What a model run reports to the AI SDK's telemetry: one span per run, step, model call and
 * tool call, with model, finish reasons, token usage and tool names — and never the prompts or
 * the replies. Those carry file contents and the reader's own questions, and the README promises
 * that nothing written or said is exported.
 *
 * Inert until an integration is registered (`adapters/otel/telemetry.ts` does, when telemetry is
 * enabled), so this costs nothing with telemetry off.
 */
export function runTelemetry(functionId: string) {
  return { functionId, recordInputs: false, recordOutputs: false }
}
