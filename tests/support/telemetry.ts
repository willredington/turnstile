import type { Attributes, Telemetry } from '../../src/core/ports.ts'

/**
 * A `Telemetry` that remembers what it was asked to measure.
 *
 * Lets the measurement points in `app/` be tested as behaviour — this span opens around that
 * work, this counter moves when a file is saved — without an OpenTelemetry SDK, a collector or a
 * wire format anywhere near the assertion. The adapter's own tests cover the export.
 */

type RecordedSpan = {
  name: string
  attrs: Attributes
  /** Whether the work inside it threw. */
  failed: boolean
}

type RecordedMetric = { name: string; value: number; attrs: Attributes }

export type RecordingTelemetry = Telemetry & {
  spans: RecordedSpan[]
  counts: RecordedMetric[]
  records: RecordedMetric[]
  /** Every span named `name`, in the order they opened. */
  spansNamed(name: string): RecordedSpan[]
  /** The total added to counter `name`, across every call. */
  totalCounted(name: string, attrs?: Attributes): number
}

function matches(recorded: Attributes, wanted: Attributes | undefined): boolean {
  if (wanted === undefined) return true
  return Object.entries(wanted).every(([key, value]) => recorded[key] === value)
}

export function recordingTelemetry(): RecordingTelemetry {
  const telemetry: RecordingTelemetry = {
    spans: [],
    counts: [],
    records: [],

    async span(name, attrs, work) {
      const entry: RecordedSpan = { name, attrs, failed: false }
      telemetry.spans.push(entry)
      try {
        return await work()
      } catch (error) {
        entry.failed = true
        throw error
      }
    },

    count(name, attrs, value) {
      telemetry.counts.push({ name, value: value ?? 1, attrs: attrs ?? {} })
    },

    record(name, value, attrs) {
      telemetry.records.push({ name, value, attrs: attrs ?? {} })
    },

    async flush() {},

    spansNamed: (name) => telemetry.spans.filter((span) => span.name === name),

    totalCounted: (name, attrs) =>
      telemetry.counts
        .filter((count) => count.name === name && matches(count.attrs, attrs))
        .reduce((total, count) => total + count.value, 0),
  }
  return telemetry
}
