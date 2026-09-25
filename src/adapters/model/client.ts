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
 * Resolves a `ModelConfig` into a `LanguageModel` over OpenRouter. Only the asker uses one: the
 * review runs on Claude Code and auto-mode on TypeSafe.
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
      `${variable} is not set. Turnstile needs an OpenRouter key to answer a question about code.`,
    )
  }
  return key
}
