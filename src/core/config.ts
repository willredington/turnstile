import { z } from 'zod'

/**
 * Review policy. This is domain data, not infrastructure — the risk bar and the gate
 * both read it — so the schema lives in core and only *loading* it is an adapter.
 */

const ProviderPrefsSchema = z.object({
  order: z.array(z.string()).optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  allow_fallbacks: z.boolean().optional(),
  sort: z.string().optional(),
})

const ModelConfigSchema = z.object({
  /** Priority-ordered fallback array. You are billed for whichever model actually serves. */
  models: z.array(z.string()).min(1, 'model.models needs at least one entry'),
  provider: ProviderPrefsSchema.optional(),
  /**
   * Determinism matters more than variety: the same delta should produce the same
   * adjudication, or the human cannot tell a new challenge from a resampled one.
   */
  temperature: z.number().min(0).max(2).default(0),
})
export type ModelConfig = z.infer<typeof ModelConfigSchema>

const RiskBarConfigSchema = z.object({
  /** Globs whose changes are always risk-checked, outranking every heuristic and neverReview. */
  alwaysReview: z.array(z.string()).default([]),
  /** Globs never risk-checked. Generated code and vendored trees live here. */
  neverReview: z.array(z.string()).default([]),
  /**
   * Globs risk-checked the same way `alwaysReview` is, for plan/spec documents the doc-path
   * heuristic would otherwise skip.
   */
  specPaths: z.array(z.string()).default([]),
})
export type RiskBarConfig = z.infer<typeof RiskBarConfigSchema>

const ReviewConfigSchema = z.object({
  /**
   * Tool-using steps one file review may take before it must submit its verdicts. Judging every
   * rule can mean grepping a changed export's callers or finding a test file, several times over.
   */
  maxSteps: z.number().int().min(1).max(50).default(16),
  /** Files reviewed at once. */
  concurrency: z.number().int().min(1).max(16).default(3),
  /** One file review's whole budget, tool calls included. */
  timeoutMs: z.number().int().min(1000).default(90_000),
  /**
   * Where this repository's rules live, when not the default `~/.turnstile/rules/<repo>/`
   * (`core/rules.ts`'s `defaultRulesDir`). Absolute, or starting `~/`. Must be outside the
   * checkout: the coding agent is not meant to see the rules its work is reviewed against.
   */
  rulesDir: z
    .string()
    .refine((dir) => dir.startsWith('/') || dir.startsWith('~/'), {
      message: 'must be an absolute path or start with ~/',
    })
    .optional(),
})
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>

const AskConfigSchema = z.object({
  /**
   * The model behind an answer. Its own key rather than the reviewer's, because the two jobs
   * are priced differently: a review runs unattended on every changed file and is worth a
   * capable model, while a question is asked by someone waiting for it and wants a fast cheap
   * one. Must support tool calling.
   */
  model: ModelConfigSchema,
  /** Tool-using steps one answer may take before it must answer with what it has. */
  maxSteps: z.number().int().min(1).max(50).default(6),
  /** One question's whole budget, tool calls included. Shorter than a review's: someone is
   *  watching a spinner. */
  timeoutMs: z.number().int().min(1000).default(60_000),
})
export type AskConfig = z.infer<typeof AskConfigSchema>

const ToolPermissionsConfigSchema = z.object({
  /**
   * Regexes that deny an otherwise-auto-approved tool call instead of prompting a human. For
   * `Bash`, matched against the full command text (`input.command`); for every other tool,
   * matched against the tool name — e.g. `^WebFetch$` denies WebFetch outright, or
   * `^mcp__some-server__` denies a whole MCP server.
   */
  denyPatterns: z
    .array(
      z.string().refine(
        (pattern) => {
          try {
            new RegExp(pattern)
            return true
          } catch {
            return false
          }
        },
        { message: 'must be a valid regular expression' },
      ),
    )
    .default([]),
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
  /**
   * The model behind the review — one tool-using run per changed file, returning a verdict on
   * every rule that governs it. It must support tool calling.
   */
  model: ModelConfigSchema,
  review: ReviewConfigSchema.default({ maxSteps: 16, concurrency: 3, timeoutMs: 90_000 }),
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
  toolPermissions: ToolPermissionsConfigSchema.default({ denyPatterns: [] }),
  /**
   * Gitignore-style patterns for untracked files that never reach the board, on top of the
   * repository's own ignore rules. Build output is the case this exists for: an agent that
   * scaffolds a Rust or Node project and builds it before anyone has written a `.gitignore`
   * would otherwise put hundreds of `target/` or `node_modules/` files up for review. Files git
   * already tracks are unaffected. Replaces the default list outright when set.
   */
  untrackedExcludes: z.array(z.string()).default([...DEFAULT_UNTRACKED_EXCLUDES]),
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

export const DEFAULT_CONFIG: TurnstileConfig = ConfigSchema.parse({
  model: { models: ['meta/muse-spark-1.1'], temperature: 0 },
})

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
