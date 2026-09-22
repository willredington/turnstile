import { afterEach, describe, expect, test } from 'bun:test'
import { generateText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { runTelemetry } from '../../../src/adapters/model/client.ts'
import { createOtelTelemetry, type OtelTelemetry } from '../../../src/adapters/otel/telemetry.ts'
import type { TelemetryConfig } from '../../../src/core/config.ts'

/**
 * The adapter is exercised against a real OTLP receiver rather than a mock exporter: the thing
 * most likely to be wrong is the wire format, and a mock of the exporter would agree with
 * whatever the adapter did. This one asserts on the JSON a collector actually receives.
 */

type Captured = { traces: unknown[]; metrics: unknown[] }

type Listening = ReturnType<typeof Bun.serve>

function collector(): { server: Listening; captured: Captured; endpoint: string } {
  const captured: Captured = { traces: [], metrics: [] }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const payload = await request.json()
      if (path === '/v1/traces') captured.traces.push(payload)
      if (path === '/v1/metrics') captured.metrics.push(payload)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  return { server, captured, endpoint: `http://127.0.0.1:${server.port}` }
}

/** OTLP nests spans under resource and scope; tests want them flat. */
type Span = {
  name: string
  spanId: string
  parentSpanId?: string
  attributes?: { key: string; value: Record<string, unknown> }[]
  status?: { code?: number; message?: string }
  events?: { name: string }[]
}

function spansIn(payloads: unknown[]): Span[] {
  return payloads.flatMap((payload) =>
    ((payload as { resourceSpans?: { scopeSpans?: { spans?: Span[] }[] }[] }).resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans ?? [])
      .flatMap((scope) => scope.spans ?? []),
  )
}

function resourceAttrs(payloads: unknown[]): Record<string, unknown> {
  const entries = payloads.flatMap(
    (payload) =>
      (
        payload as {
          resourceSpans?: {
            resource?: { attributes?: { key: string; value: { stringValue?: string } }[] }
          }[]
        }
      ).resourceSpans?.flatMap((resource) => resource.resource?.attributes ?? []) ?? [],
  )
  return Object.fromEntries(entries.map((attr) => [attr.key, attr.value.stringValue]))
}

function attrOf(span: Span, key: string): unknown {
  const found = (span.attributes ?? []).find((attr) => attr.key === key)
  if (found === undefined) return undefined
  return Object.values(found.value)[0]
}

type Metric = { name: string; sum?: unknown; histogram?: unknown }

function metricsIn(payloads: unknown[]): Metric[] {
  return payloads.flatMap((payload) =>
    (
      (payload as { resourceMetrics?: { scopeMetrics?: { metrics?: Metric[] }[] }[] })
        .resourceMetrics ?? []
    )
      .flatMap((resource) => resource.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics ?? []),
  )
}

const base = (endpoint: string): TelemetryConfig => ({
  enabled: true,
  endpoint,
  serviceName: 'turnstile',
  traces: true,
  metrics: true,
  agent: true,
  diagnostics: false,
})

let open: { telemetry: OtelTelemetry; server: Listening } | null = null

afterEach(async () => {
  if (open === null) return
  await open.telemetry.shutdown()
  await open.server.stop(true)
  open = null
})

/** Build a telemetry bound to a fresh collector, and register both for teardown. */
function harness(overrides: Partial<TelemetryConfig> = {}): {
  telemetry: OtelTelemetry
  captured: Captured
} {
  const { server, captured, endpoint } = collector()
  const telemetry = createOtelTelemetry({ ...base(endpoint), ...overrides })
  open = { telemetry, server }
  return { telemetry, captured }
}

describe('the OpenTelemetry adapter', () => {
  test('exports a span under the configured service name', async () => {
    const { telemetry, captured } = harness()

    await telemetry.span('turnstile.review.run', { 'turnstile.files': 3 }, async () => 'done')
    await telemetry.flush()

    const [span] = spansIn(captured.traces)
    expect(span?.name).toBe('turnstile.review.run')
    expect(attrOf(span as Span, 'turnstile.files')).toBe(3)
    expect(resourceAttrs(captured.traces)['service.name']).toBe('turnstile')
  })

  test('hands back the result of the work it wrapped', async () => {
    const { telemetry } = harness()
    expect(await telemetry.span('turnstile.diff', {}, async () => ({ files: 7 }))).toEqual({
      files: 7,
    })
  })

  /** The whole point of a trace: `review.file` has to sit under the `review.run` that caused it. */
  test('nests an inner span under the span it ran inside', async () => {
    const { telemetry, captured } = harness()

    await telemetry.span('turnstile.review.run', {}, async () => {
      await telemetry.span(
        'turnstile.review.file',
        { 'turnstile.path': 'src/a.ts' },
        async () => {},
      )
    })
    await telemetry.flush()

    const spans = spansIn(captured.traces)
    const outer = spans.find((span) => span.name === 'turnstile.review.run')
    const inner = spans.find((span) => span.name === 'turnstile.review.file')
    expect(inner?.parentSpanId).toBe(outer?.spanId as string)
  })

  test('marks a failing span as an error and still lets the failure through', async () => {
    const { telemetry, captured } = harness()

    const failing = telemetry.span('turnstile.review.file', {}, async () => {
      throw new Error('model refused')
    })
    await expect(failing).rejects.toThrow('model refused')
    await telemetry.flush()

    const [span] = spansIn(captured.traces)
    // 2 is OTLP's STATUS_CODE_ERROR.
    expect(span?.status?.code).toBe(2)
    expect(span?.events?.map((event) => event.name)).toContain('exception')
  })

  /**
   * A model run is where "it failed" needs explaining: which steps ran, which tools they called
   * and how the run ended. The AI SDK reports that itself once an integration is registered —
   * under whichever Turnstile span it ran inside, and without the prompt or the reply.
   */
  test('traces a model run under the span it ran inside, without its prompt or reply', async () => {
    const { telemetry, captured } = harness()
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'SECRET-REPLY' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    })

    await telemetry.span('turnstile.ask', {}, () =>
      generateText({ model, prompt: 'SECRET-PROMPT', telemetry: runTelemetry('turnstile.ask') }),
    )
    await telemetry.flush()

    const spans = spansIn(captured.traces)
    const outer = spans.find((span) => span.name === 'turnstile.ask')
    const children = spans.filter((span) => span.parentSpanId === outer?.spanId)
    expect(children.length).toBeGreaterThan(0)
    const exported = JSON.stringify(captured.traces)
    expect(exported).toContain('stop')
    expect(exported).not.toContain('SECRET-PROMPT')
    expect(exported).not.toContain('SECRET-REPLY')
  })

  test('stops tracing model runs once shut down', async () => {
    const { telemetry } = harness()
    await telemetry.shutdown()
    const registered = (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] })
      .AI_SDK_TELEMETRY_INTEGRATIONS
    expect(registered ?? []).toEqual([])
  })

  test('exports a counter as a sum', async () => {
    const { telemetry, captured } = harness()

    telemetry.count('turnstile.findings', { severity: 'high' }, 2)
    await telemetry.flush()

    const metric = metricsIn(captured.metrics).find((m) => m.name === 'turnstile.findings')
    expect(metric?.sum).toBeDefined()
  })

  test('exports a recorded measurement as a histogram, so latency keeps its shape', async () => {
    const { telemetry, captured } = harness()

    telemetry.record('turnstile.editor.keystroke.latency', 1.2)
    await telemetry.flush()

    const metric = metricsIn(captured.metrics).find(
      (m) => m.name === 'turnstile.editor.keystroke.latency',
    )
    expect(metric?.histogram).toBeDefined()
  })

  test('exports nothing at all when traces are off', async () => {
    const { telemetry, captured } = harness({ traces: false })

    await telemetry.span('turnstile.diff', {}, async () => {})
    telemetry.count('turnstile.notes.sent')
    await telemetry.flush()

    expect(spansIn(captured.traces)).toEqual([])
    expect(metricsIn(captured.metrics).length).toBeGreaterThan(0)
  })

  /**
   * The invariant from the port: measuring must not change what the app does. A collector that
   * is not listening is the normal case for anyone who configured an endpoint and forgot to
   * start it, and it must cost nothing but the measurements.
   */
  test('a collector that refuses the connection changes nothing', async () => {
    const telemetry = createOtelTelemetry({
      ...base('http://127.0.0.1:1'),
      diagnostics: false,
    })
    try {
      expect(await telemetry.span('turnstile.diff', {}, async () => 'still ran')).toBe('still ran')
      telemetry.count('turnstile.findings')
      telemetry.record('turnstile.editor.keystroke.latency', 1)
      await telemetry.flush()
    } finally {
      await telemetry.shutdown()
    }
  })
})
