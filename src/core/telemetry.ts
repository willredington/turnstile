import type { TelemetryConfig } from './config.ts'
import type { Attributes, Telemetry } from './ports.ts'

/**
 * Telemetry when nobody is collecting it.
 *
 * The default everywhere, and what the whole test suite runs against, so it is the thing that
 * guarantees the measurement points added across `app/` cost nothing and change nothing when
 * exporting is off — which is the normal case, since the config defaults to disabled.
 */
export const noopTelemetry: Telemetry = {
  span: (_name, _attrs, work) => work(),
  count: () => {},
  record: () => {},
  flush: async () => {},
}

/**
 * The environment that turns on the agent CLI's own OpenTelemetry instrumentation.
 *
 * The Claude Code CLI is already instrumented — it records spans per model request and tool
 * call and emits token and cost metrics — and `adapters/agent-sdk/client.ts` spreads
 * `process.env` into the subprocess it spawns. So the whole agent half of the picture is
 * configuration rather than code: the composition root puts these on `process.env` before it
 * builds the agent client.
 *
 * Two things are deliberately absent. `OTEL_SERVICE_NAME` is left alone so the agent keeps
 * reporting as `claude-code` and stays tellable from Turnstile's own spans in the backend. And
 * none of `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` or
 * `OTEL_LOG_RAW_API_BODIES` is set: those put the reader's prompts and file contents into the
 * exported data, and that is a decision to take in your own shell, not one Turnstile takes for
 * you.
 */
export function agentTelemetryEnv(config: TelemetryConfig): Record<string, string> {
  if (!config.enabled || !config.agent) return {}

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    // `console` would write telemetry to stdout, which is the channel the SDK talks to the CLI
    // over — it breaks the agent rather than merely losing the measurements. `none` is how OTel
    // spells a disabled signal.
    OTEL_TRACES_EXPORTER: config.traces ? 'otlp' : 'none',
    OTEL_METRICS_EXPORTER: config.metrics ? 'otlp' : 'none',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: config.endpoint,
    // Prometheus's OTLP ingest stores cumulative sums and drops delta ones, so without this the
    // agent's metrics — cost and tokens included — are accepted by a collector and then silently
    // lost on the way into storage. Found against Grafana's `otel-lgtm` stack, where Turnstile's
    // own metrics landed and every one of the agent's did not.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
    // The CLI's defaults are 60s for metrics and 5s for the rest, long enough that a short turn
    // can finish before anything is flushed.
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_TRACES_EXPORT_INTERVAL: '5000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
  }

  // Tracing is behind a beta flag, and asking for it without the flag yields no spans at all.
  if (config.traces) env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1'
  if (config.headers !== undefined) env.OTEL_EXPORTER_OTLP_HEADERS = config.headers
  if (config.diagnostics) env.CLAUDE_CODE_OTEL_DIAG_STDERR = '1'

  return env
}

/**
 * The measurements the browser is allowed to report, and what they are called once exported.
 *
 * An allowlist rather than a validated pattern, because a metric name is a dimension in the
 * backend: anything that can mint names from outside the process can mint unbounded series.
 * Adding a measurement here is the deliberate act of deciding it is worth a series.
 */
const BROWSER_MEASUREMENTS = new Set([
  /** Milliseconds to lay out a document when a file is opened. */
  'editor.build',
  /** Milliseconds from keypress to laid-out document — the figure the CM6 pivot was about. */
  'editor.keystroke.latency',
])

/** Attributes a browser measurement may carry. Everything else is dropped. */
const BROWSER_ATTRIBUTES = new Set(['language', 'surface'])

/** Long enough for any real batch, short enough that a bad actor cannot flood the exporter. */
const MAX_BROWSER_MEASUREMENTS = 256

/** Keeps an attribute a dimension rather than a payload — and keeps file paths out of it. */
const MAX_ATTRIBUTE_LENGTH = 64

export type BrowserMeasurement = { name: string; value: number; attrs: Attributes }

/**
 * Validate a batch of measurements posted by the editor.
 *
 * Nothing here trusts the request: keystroke latency is measured in the browser, so this is the
 * one path by which a name, a value and a set of dimensions reach the exporter from outside the
 * process. Everything unrecognised is dropped silently rather than refused — a measurement is
 * never worth an error to the reader.
 */
export function parseBrowserMeasurements(body: unknown): BrowserMeasurement[] {
  const raw = (body as { measurements?: unknown } | null)?.measurements
  if (!Array.isArray(raw)) return []

  const measurements: BrowserMeasurement[] = []
  for (const entry of raw.slice(0, MAX_BROWSER_MEASUREMENTS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, value, attrs } = entry as { name?: unknown; value?: unknown; attrs?: unknown }

    if (typeof name !== 'string' || !BROWSER_MEASUREMENTS.has(name)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue

    const kept: Attributes = {}
    if (typeof attrs === 'object' && attrs !== null) {
      for (const [key, attr] of Object.entries(attrs)) {
        if (!BROWSER_ATTRIBUTES.has(key)) continue
        if (typeof attr !== 'string' || attr.length > MAX_ATTRIBUTE_LENGTH) continue
        kept[key] = attr
      }
    }

    // Prefixed here rather than by the caller so nothing reported from the browser can land
    // under `claude_code.*` and be mistaken for the agent's own instrumentation.
    measurements.push({ name: `turnstile.${name}`, value, attrs: kept })
  }
  return measurements
}

/**
 * A `Telemetry` that stamps `attrs()` on everything passing through it.
 *
 * What ties Turnstile's measurements to the agent's. The Claude Code CLI puts `session.id` on
 * its own spans; wrapping Turnstile's telemetry in the same id is what lets a backend line up
 * the review that ran against the turn that caused it.
 *
 * `attrs` is a function, not a value, because a session can be replaced while the process lives
 * — a resume, or a new conversation — and a captured id would go on labelling later work with
 * the name of an earlier session. The caller's own attributes win a collision, being the more
 * specific of the two.
 */
export function withAttributes(base: Telemetry, attrs: () => Attributes): Telemetry {
  return {
    span: (name, own, work) => base.span(name, { ...attrs(), ...own }, work),
    count: (name, own, value) => base.count(name, { ...attrs(), ...own }, value),
    record: (name, value, own) => base.record(name, value, { ...attrs(), ...own }),
    flush: () => base.flush(),
  }
}
