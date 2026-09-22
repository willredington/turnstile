import { describe, expect, test } from 'bun:test'
import {
  agentTelemetryEnv,
  noopTelemetry,
  parseBrowserMeasurements,
  withAttributes,
} from '../../src/core/telemetry.ts'
import { recordingTelemetry } from '../support/telemetry.ts'

/**
 * Telemetry's first duty is to be invisible: measuring the app must never change what the app
 * does. Every test here is that invariant, because the no-op is what every session runs with
 * until someone turns exporting on, and what every other test in the suite runs with.
 */
describe('the no-op telemetry', () => {
  test('runs the work it wraps and hands back its result', async () => {
    const result = await noopTelemetry.span('turnstile.review.run', {}, async () => 'reviewed')
    expect(result).toBe('reviewed')
  })

  test('runs the work exactly once', async () => {
    let calls = 0
    await noopTelemetry.span('turnstile.diff', {}, async () => {
      calls += 1
    })
    expect(calls).toBe(1)
  })

  test('lets a failure through instead of swallowing it', async () => {
    const failing = noopTelemetry.span('turnstile.review.file', {}, async () => {
      throw new Error('model refused')
    })
    await expect(failing).rejects.toThrow('model refused')
  })

  test('counting, recording and flushing are all safe to call', async () => {
    noopTelemetry.count('turnstile.findings', { severity: 'high' })
    noopTelemetry.count('turnstile.notes.sent')
    noopTelemetry.record('turnstile.editor.keystroke.latency', 1.2)
    await noopTelemetry.flush()
  })
})

/**
 * The agent's telemetry is configuration, not code: the Claude Code CLI is instrumented
 * already, and `adapters/agent-sdk/client.ts` spreads `process.env` into the subprocess it
 * spawns. So getting the agent's spans, tokens and cost is a matter of putting the right
 * variables in the environment — and of not putting the wrong ones there.
 */
describe('the environment handed to the agent CLI', () => {
  const on = {
    enabled: true,
    endpoint: 'http://127.0.0.1:4318',
    serviceName: 'turnstile',
    traces: true,
    metrics: true,
    agent: true,
    diagnostics: false,
  }

  test('is empty while telemetry is off, so the agent runs exactly as before', () => {
    expect(agentTelemetryEnv({ ...on, enabled: false })).toEqual({})
  })

  test('is empty when only Turnstile is exporting, not the agent', () => {
    expect(agentTelemetryEnv({ ...on, agent: false })).toEqual({})
  })

  test('turns the CLI on and points it at the collector', () => {
    const env = agentTelemetryEnv(on)
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318')
  })

  test('sends to the collector as protobuf, which every collector accepts', () => {
    expect(agentTelemetryEnv(on).OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf')
  })

  test('asks for the beta flag traces need, and for the otlp exporters', () => {
    const env = agentTelemetryEnv(on)
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1')
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp')
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp')
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp')
  })

  test('leaves the agent named claude-code, so its spans stay tellable from Turnstile s', () => {
    expect(agentTelemetryEnv(on).OTEL_SERVICE_NAME).toBeUndefined()
  })

  test('disables the trace exporter rather than omitting it when traces are off', () => {
    const env = agentTelemetryEnv({ ...on, traces: false })
    expect(env.OTEL_TRACES_EXPORTER).toBe('none')
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined()
  })

  test('disables the metrics exporter rather than omitting it when metrics are off', () => {
    expect(agentTelemetryEnv({ ...on, metrics: false }).OTEL_METRICS_EXPORTER).toBe('none')
  })

  /**
   * The SDK talks to the CLI over stdout. An exporter that writes telemetry there corrupts
   * that channel, which would break the agent rather than merely lose the measurements.
   */
  test('never names the console exporter, which would corrupt the SDK s own channel', () => {
    for (const config of [on, { ...on, traces: false }, { ...on, metrics: false }]) {
      expect(Object.values(agentTelemetryEnv(config))).not.toContain('console')
    }
  })

  /**
   * Turnstile reads the reader's source and prompts. These four variables put that content in
   * the exported data, so Turnstile never sets them; someone who wants them sets them in their
   * own shell, deliberately.
   */
  test('never opts in to exporting prompts, file contents or raw API bodies', () => {
    const env = agentTelemetryEnv(on)
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined()
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined()
    expect(env.OTEL_LOG_TOOL_CONTENT).toBeUndefined()
    expect(env.OTEL_LOG_RAW_API_BODIES).toBeUndefined()
  })

  test('passes collector headers through only when there are some', () => {
    expect(agentTelemetryEnv(on).OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined()
    expect(
      agentTelemetryEnv({ ...on, headers: 'Authorization=Bearer t' }).OTEL_EXPORTER_OTLP_HEADERS,
    ).toBe('Authorization=Bearer t')
  })

  /** The CLI drops telemetry silently when the collector refuses it, which is the failure
   *  mode hardest to notice; this is the switch that makes it say so. */
  test('asks the CLI to report exporter failures only when diagnostics are on', () => {
    expect(agentTelemetryEnv(on).CLAUDE_CODE_OTEL_DIAG_STDERR).toBeUndefined()
    expect(agentTelemetryEnv({ ...on, diagnostics: true }).CLAUDE_CODE_OTEL_DIAG_STDERR).toBe('1')
  })

  /**
   * Asks the CLI for cumulative sums rather than delta.
   *
   * Found live, not reasoned about: pointed at Grafana's `otel-lgtm` stack, every one of the
   * agent's 12 metric points was accepted by the collector and then dropped on its way into
   * Prometheus, while Turnstile's own metrics landed. Prometheus's OTLP ingest wants cumulative
   * sums and discards delta ones unless started with a feature flag nobody should have to know
   * about. Turnstile's own exporter is cumulative by default, which is exactly why only the
   * agent's half went missing — and why `claude_code.cost.usage`, the single most useful number
   * the agent reports, was the one you could not see.
   */
  test('asks the CLI for cumulative metrics, which is what Prometheus can store', () => {
    expect(agentTelemetryEnv(on).OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe(
      'cumulative',
    )
  })

  /** A short-lived turn can finish before the default 60s metrics interval ever fires. */
  test('shortens the export intervals so a quick turn s data still arrives', () => {
    const env = agentTelemetryEnv(on)
    expect(Number(env.OTEL_METRIC_EXPORT_INTERVAL)).toBeLessThanOrEqual(10_000)
    expect(Number(env.OTEL_TRACES_EXPORT_INTERVAL)).toBeLessThanOrEqual(5_000)
    expect(Number(env.OTEL_LOGS_EXPORT_INTERVAL)).toBeLessThanOrEqual(5_000)
  })
})

/**
 * Measurements the browser reports.
 *
 * Keystroke latency can only be measured where the keystroke is, so the editor sends its timings
 * to the server to be exported. That makes this the one place where a metric name arrives from
 * outside the process, and metric names are dimensions in the backend: an open name field is a
 * cardinality hazard, not just a validation nicety. Hence an allowlist rather than a pattern.
 */
describe('measurements reported by the browser', () => {
  const one = (measurements: unknown) => parseBrowserMeasurements({ measurements })

  test('accepts a known measurement', () => {
    expect(one([{ name: 'editor.keystroke.latency', value: 1.25 }])).toEqual([
      { name: 'turnstile.editor.keystroke.latency', value: 1.25, attrs: {} },
    ])
  })

  test('prefixes every name, so nothing can name itself after the agent s metrics', () => {
    const [measurement] = one([{ name: 'editor.build', value: 12 }])
    expect(measurement?.name).toBe('turnstile.editor.build')
  })

  test('drops a name that is not on the allowlist', () => {
    expect(one([{ name: 'editor.something.invented', value: 1 }])).toEqual([])
    expect(one([{ name: 'claude_code.llm_request', value: 1 }])).toEqual([])
  })

  test('drops a value that is not a finite, non-negative number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, '3', null, undefined]) {
      expect(one([{ name: 'editor.build', value }])).toEqual([])
    }
  })

  test('keeps only the attributes that are meant to be dimensions', () => {
    const [measurement] = one([
      {
        name: 'editor.build',
        value: 5,
        attrs: { language: 'typescript', path: 'src/secret.ts', invented: 'x' },
      },
    ])
    expect(measurement?.attrs).toEqual({ language: 'typescript' })
  })

  /** A path or a file's text as a dimension would be both a cardinality and a privacy problem. */
  test('drops an attribute whose value is not a short string', () => {
    const [measurement] = one([
      { name: 'editor.build', value: 5, attrs: { language: 'x'.repeat(200) } },
    ])
    expect(measurement?.attrs).toEqual({})
  })

  test('caps how many measurements one report can carry', () => {
    const many = Array.from({ length: 5_000 }, () => ({ name: 'editor.build', value: 1 }))
    expect(one(many).length).toBeLessThanOrEqual(256)
  })

  test('treats anything malformed as nothing to record', () => {
    expect(parseBrowserMeasurements(null)).toEqual([])
    expect(parseBrowserMeasurements({})).toEqual([])
    expect(one('not an array')).toEqual([])
    expect(one([null, 3, 'x'])).toEqual([])
  })
})

/**
 * Stamping every measurement with the session it came from.
 *
 * This is what makes the two halves of the picture one picture: the agent CLI stamps
 * `session.id` on its own spans, so Turnstile stamping the same id on its own is what lets a
 * backend show the review that ran alongside a turn. Correlation by attribute, deliberately,
 * rather than by making the agent's spans children of Turnstile's — see
 * `adapters/otel/telemetry.ts`.
 */
describe('telemetry carrying fixed attributes', () => {
  test('adds them to a span', async () => {
    const inner = recordingTelemetry()
    const tagged = withAttributes(inner, () => ({ 'session.id': 'sess-1' }))

    await tagged.span('turnstile.diff', { 'turnstile.root': '/repo' }, async () => {})

    expect(inner.spans[0]?.attrs).toEqual({ 'turnstile.root': '/repo', 'session.id': 'sess-1' })
  })

  test('adds them to counters and recordings', async () => {
    const inner = recordingTelemetry()
    const tagged = withAttributes(inner, () => ({ 'session.id': 'sess-1' }))

    tagged.count('turnstile.notes.sent', {}, 2)
    tagged.record('turnstile.editor.build', 12)

    expect(inner.counts[0]?.attrs).toEqual({ 'session.id': 'sess-1' })
    expect(inner.records[0]?.attrs).toEqual({ 'session.id': 'sess-1' })
  })

  /** A session id is read at the moment of measuring, because a session can be replaced. */
  test('re-reads the attributes on every call rather than capturing them once', async () => {
    const inner = recordingTelemetry()
    let id = 'sess-1'
    const tagged = withAttributes(inner, () => ({ 'session.id': id }))

    tagged.count('turnstile.notes.sent')
    id = 'sess-2'
    tagged.count('turnstile.notes.sent')

    expect(inner.counts.map((count) => count.attrs['session.id'])).toEqual(['sess-1', 'sess-2'])
  })

  test('lets the call s own attribute win, being the more specific', async () => {
    const inner = recordingTelemetry()
    const tagged = withAttributes(inner, () => ({ 'session.id': 'sess-1' }))

    tagged.count('turnstile.notes.sent', { 'session.id': 'explicit' })

    expect(inner.counts[0]?.attrs['session.id']).toBe('explicit')
  })

  test('still returns the work s result and still flushes', async () => {
    const inner = recordingTelemetry()
    const tagged = withAttributes(inner, () => ({}))

    expect(await tagged.span('turnstile.diff', {}, async () => 'value')).toBe('value')
    await tagged.flush()
  })
})
