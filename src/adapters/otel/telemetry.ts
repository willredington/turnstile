import { OpenTelemetry } from '@ai-sdk/otel'
import {
  type Counter,
  context,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Histogram,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { type Telemetry as ModelTelemetry, registerTelemetry } from 'ai'
import type { TelemetryConfig } from '../../core/config.ts'
import type { Telemetry } from '../../core/ports.ts'

/**
 * Turnstile's own measurements, over OTLP.
 *
 * Only Turnstile's half of the picture: the agent's spans, tokens and cost are exported by the
 * Claude Code CLI's own instrumentation, configured by `core/telemetry.ts`'s
 * `agentTelemetryEnv`. The two meet in the backend, where Turnstile's spans carry the same
 * `session.id` the CLI stamps on its own — correlated by attribute rather than nested, because
 * the SDK opens one long-lived `query()` per session, so nesting would hang every turn of a
 * multi-hour session off one short parent span.
 *
 * Every method here swallows its own failures. A collector that is down, misconfigured or
 * simply never started is the ordinary case, and it has to cost the measurements and nothing
 * else — `span` in particular must run its work and return its result even if tracing itself
 * throws.
 */
export type OtelTelemetry = Telemetry & {
  /** Flush, stop the exporters, and release the global tracer registration. */
  shutdown(): Promise<void>
}

/** `key=value,key=value` — the shape OTEL_EXPORTER_OTLP_HEADERS uses. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {}
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return headers
}

function signalUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`
}

/**
 * How long a flush is allowed to take before we stop waiting for it.
 *
 * OTLP exporters retry with backoff, so flushing to a collector that is not listening does not
 * fail — it waits, and `forceFlush` waits with it. Since `flush` runs on the way out of the
 * process, an unbounded one turns a stale endpoint in a config file into an app that will not
 * exit. Giving up loses the last batch, which is the correct thing to lose.
 */
const FLUSH_TIMEOUT_MS = 2_000

function withTimeout(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => {
      // Unreferenced so a pending timer never holds the process open by itself.
      setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()
    }),
  ])
}

export function createOtelTelemetry(config: TelemetryConfig): OtelTelemetry {
  // The exporters log dropped batches through diag, whose default logger discards them. Without
  // this, an endpoint that rejects everything looks identical to an app emitting nothing.
  if (config.diagnostics) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName })
  const headers = parseHeaders(config.headers)

  const tracerProvider = config.traces
    ? new NodeTracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: signalUrl(config.endpoint, 'traces'), headers }),
          ),
        ],
      })
    : null

  // Registering globally is what makes nesting work: `startActiveSpan` reads the parent from the
  // global context manager, and without one every span would come out a root.
  tracerProvider?.register()
  const tracer = tracerProvider?.getTracer('turnstile') ?? null

  // The model runs — the reviewer's and the asker's — are traced by the AI SDK itself: a span per
  // run, step, model call and tool call, with finish reasons, usage and tool names. That is what
  // explains a failed review or an unanswered question, which Turnstile's own span around the run
  // can only report as "it threw". Each call opts in with `adapters/model/client.ts`'s
  // `runTelemetry`, which is also what keeps prompts and replies out of the export.
  const modelTelemetry: ModelTelemetry | null =
    tracer === null ? null : new OpenTelemetry({ tracer, usage: true })
  if (modelTelemetry !== null) registerTelemetry(modelTelemetry)

  const meterProvider = config.metrics
    ? new MeterProvider({
        resource,
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: signalUrl(config.endpoint, 'metrics'),
              headers,
            }),
            exportIntervalMillis: 10_000,
          }),
        ],
      })
    : null
  const meter = meterProvider?.getMeter('turnstile') ?? null

  // Instruments are cached because creating one per call would register a duplicate
  // instrument on every count, which the SDK warns about and which costs allocation per edit.
  const counters = new Map<string, Counter>()
  const histograms = new Map<string, Histogram>()

  return {
    async span(name, attrs, work) {
      if (tracer === null) return work()
      return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
        try {
          const result = await work()
          span.setStatus({ code: SpanStatusCode.OK })
          return result
        } catch (error) {
          // Recorded, then rethrown unchanged: the caller's own error handling is the contract,
          // and a span is not allowed to become part of it.
          const failure = error instanceof Error ? error : new Error(String(error))
          span.recordException(failure)
          span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message })
          throw error
        } finally {
          span.end()
        }
      })
    },

    count(name, attrs, value) {
      if (meter === null) return
      try {
        let counter = counters.get(name)
        if (counter === undefined) {
          counter = meter.createCounter(name)
          counters.set(name, counter)
        }
        counter.add(value ?? 1, attrs)
      } catch {
        // Measuring is never worth failing a turn over.
      }
    },

    record(name, value, attrs) {
      if (meter === null) return
      try {
        let histogram = histograms.get(name)
        if (histogram === undefined) {
          histogram = meter.createHistogram(name)
          histograms.set(name, histogram)
        }
        histogram.record(value, attrs)
      } catch {
        // As above.
      }
    },

    async flush() {
      await withTimeout(
        Promise.allSettled([tracerProvider?.forceFlush(), meterProvider?.forceFlush()]),
      )
    },

    async shutdown() {
      await withTimeout(Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown()]))
      // `register()` installed a global tracer provider, context manager and propagator; leaving
      // them in place would leak across a restart in-process, and across tests.
      if (tracerProvider !== null) {
        // `registerTelemetry` has no inverse; the registry is a plain global array.
        const registry = (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] })
          .AI_SDK_TELEMETRY_INTEGRATIONS
        const at = registry?.indexOf(modelTelemetry) ?? -1
        if (at >= 0) registry?.splice(at, 1)
        trace.disable()
        context.disable()
        propagation.disable()
      }
      if (config.diagnostics) diag.disable()
    },
  }
}
