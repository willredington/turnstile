import { z } from 'zod'

/**
 * Turnstile's configuration. This is domain data, not infrastructure — the risk bar and the
 * review both read it — so the schema lives in core and only *loading* it is an adapter.
 *
 * Three services, three sections: the review is Claude Code (`review`), answering a question
 * about code is a model over OpenRouter (`ask`, `openrouter`), and auto-mode's judge is TypeSafe
 * (`typesafe`). API keys are only ever read from the environment, named by `apiKeyEnv`.
 */

const ProviderPrefsSchema = z.object({
  order: z.array(z.string()).optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  allow_fallbacks: z.boolean().optional(),
  sort: z.string().optional(),
})

const ModelConfigSchema = z.object({
  /** OpenRouter model ids, a priority-ordered fallback list. You are billed for whichever serves. */
  models: z.array(z.string()).min(1, 'model.models needs at least one entry'),
  provider: ProviderPrefsSchema.optional(),
  /** Low by default: the same question about the same code should get the same answer. */
  temperature: z.number().min(0).max(2).default(0),
})
export type ModelConfig = z.infer<typeof ModelConfigSchema>

const RiskBarConfigSchema = z.object({
  /** Globs whose changes are always reviewed, outranking every skip rule and neverReview. */
  alwaysReview: z.array(z.string()).default([]),
  /** Globs never reviewed, added to the built-in generated/vendored list rather than replacing it. */
  neverReview: z.array(z.string()).default([]),
  /**
   * Globs reviewed the same way `alwaysReview` is, for plan/spec documents the doc-path
   * heuristic would otherwise skip.
   */
  specPaths: z.array(z.string()).default([]),
})
export type RiskBarConfig = z.infer<typeof RiskBarConfigSchema>

const ReviewConfigSchema = z.object({
  /**
   * The Claude model the reviewer runs on — an alias (`sonnet`, `opus`) or a full id. Unset, it
   * is whatever the `claude` CLI defaults to. The reviewer is Claude Code itself, authenticated
   * the way the coding agent is; it does not go through OpenRouter.
   */
  model: z.string().min(1).optional(),
  /** Model round-trips one review may take — every read, search and command counts. */
  maxTurns: z.number().int().min(1).max(500).default(60),
  /** One review's whole budget. It reads every file a turn changed, so it is not quick. */
  timeoutMs: z.number().int().min(1000).default(600_000),
})
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>

const AskConfigSchema = z.object({
  /**
   * The model behind an answer, over OpenRouter: a question is asked by someone waiting for it,
   * and wants a fast, cheap model. Must support tool calling.
   */
  model: ModelConfigSchema,
  /** Tool-using steps one answer may take before it must answer with what it has. */
  maxSteps: z.number().int().min(1).max(50).default(6),
  /** One question's whole budget, tool calls included. Shorter than a review's: someone is
   *  watching a spinner. */
  timeoutMs: z.number().int().min(1000).default(60_000),
})
export type AskConfig = z.infer<typeof AskConfigSchema>

const TypeSafeConfigSchema = z.object({
  /** The environment variable holding the TypeSafe API key auto-mode judges calls with. */
  apiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
  /** The System One model that answers auto-mode's questions. */
  model: z.string().min(1).default('jev-latest'),
  /**
   * One verdict's whole budget. The agent waits on it before every tool call, so it is short;
   * a verdict that misses it asks the human rather than letting the call through.
   */
  timeoutMs: z.number().int().min(500).default(5_000),
})

/** See `ConfigSchema.untrackedExcludes`. */
const DEFAULT_UNTRACKED_EXCLUDES = [
  'target/',
  'node_modules/',
  'dist/',
  'build/',
  '.venv/',
  '__pycache__/',
] as const

const TelemetryConfigSchema = z.object({
  /** Off unless asked for. Nothing is exported, and the agent CLI is left unconfigured. */
  enabled: z.boolean().default(false),
  /** An OTLP endpoint — a local collector by default. `jaegertracing/all-in-one` listens here. */
  endpoint: z.string().min(1).default('http://127.0.0.1:4318'),
  /** How Turnstile's own spans are named in the backend. The agent's stay `claude-code`. */
  serviceName: z.string().min(1).default('turnstile'),
  traces: z.boolean().default(true),
  metrics: z.boolean().default(true),
  /** Also configure the agent CLI's built-in instrumentation, not just Turnstile's own. */
  agent: z.boolean().default(true),
  /** `key=value,key=value`, for a collector that wants an Authorization header. */
  headers: z.string().optional(),
  /**
   * Report exporter failures instead of dropping telemetry silently. Worth turning on the
   * first time you point Turnstile at a new collector, since the quiet failure is otherwise
   * indistinguishable from an app that emits nothing.
   */
  diagnostics: z.boolean().default(false),
})

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>

export const ConfigSchema = z.object({
  /** The reviewer: a read-only Claude Code run over the files each turn changed. */
  review: ReviewConfigSchema.default({ maxTurns: 60, timeoutMs: 600_000 }),
  /** The model behind "highlight some code and ask about it". Read-only, and never the agent. */
  ask: AskConfigSchema.default({
    model: { models: ['anthropic/claude-haiku-4.5'], temperature: 0 },
    maxSteps: 6,
    timeoutMs: 60_000,
  }),
  riskBar: RiskBarConfigSchema.default({
    alwaysReview: [],
    neverReview: [],
    specPaths: [],
  }),
  /** Auto-mode's judge. The statements it judges against are the user's own, set up in the app. */
  typesafe: TypeSafeConfigSchema.default({
    apiKeyEnv: 'TYPESAFE_API_KEY',
    model: 'jev-latest',
    timeoutMs: 5_000,
  }),
  /**
   * Gitignore-style patterns for untracked files that never reach the board, on top of the
   * repository's own ignore rules. Build output is the case this exists for: an agent that
   * scaffolds a Rust or Node project and builds it before anyone has written a `.gitignore`
   * would otherwise put hundreds of `target/` or `node_modules/` files up for review. Files git
   * already tracks are unaffected. Replaces the default list outright when set.
   */
  untrackedExcludes: z.array(z.string()).default([...DEFAULT_UNTRACKED_EXCLUDES]),
  /** Only "ask about code" uses OpenRouter; the review and auto-mode never do. */
  openrouter: z
    .object({ apiKeyEnv: z.string().min(1).default('OPENROUTER_API_KEY') })
    .default({ apiKeyEnv: 'OPENROUTER_API_KEY' }),
  /** Where Turnstile's own measurements go, and whether they are taken at all. */
  telemetry: TelemetryConfigSchema.default({
    enabled: false,
    endpoint: 'http://127.0.0.1:4318',
    serviceName: 'turnstile',
    traces: true,
    metrics: true,
    agent: true,
    diagnostics: false,
  }),
})

export type TurnstileConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: TurnstileConfig = ConfigSchema.parse({})

/** Turnstile's own state directory, excluded from every delta. */
export const STATE_DIR = '.turnstile'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Layer one raw config object over another, JSON-merge-patch style: a key present in both as
 * a plain object recurses, anything else in `override` (arrays included) replaces `base`
 * wholesale. Arrays replacing rather than concatenating matters here specifically — a repo's
 * own `riskBar` globs should never silently pick up entries from someone's personal config the
 * repo's author never saw.
 *
 * Takes and returns `unknown`: this runs on raw, not-yet-validated JSON, before either layer
 * has been through `ConfigSchema` — validation happens once, on the merged result.
 */
export function mergeConfigLayers(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeConfigLayers(merged[key], value)
  }
  return merged
}
