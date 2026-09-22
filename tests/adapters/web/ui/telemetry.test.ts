import { afterEach, describe, expect, test } from 'bun:test'
import { createReporter, MAX_BUFFERED } from '../../../../src/adapters/web/ui/telemetry.ts'

/**
 * The editor's side of the measurement bridge.
 *
 * Keystroke latency has to be timed in the browser, and a request per keystroke would cost more
 * than the thing being measured. So measurements buffer and go out in batches — which makes the
 * properties worth holding: never a request per keystroke, never the same batch twice, and never
 * an unbounded buffer when the server is not answering.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Sent = {
  path: string
  body: { measurements: { name: string; value: number; attrs: Record<string, string> }[] }
}

function capturing(ok = true): Sent[] {
  const sent: Sent[] = []
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init.body)) })
    if (!ok) throw new Error('connection refused')
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return sent
}

describe('the editor s measurement reporter', () => {
  test('does not make a request per measurement', () => {
    const sent = capturing()
    const reporter = createReporter()

    for (let i = 0; i < 50; i++) reporter.measure('editor.keystroke.latency', 1)

    expect(sent).toEqual([])
  })

  test('sends what it buffered, to the telemetry route', async () => {
    const sent = capturing()
    const reporter = createReporter()

    reporter.measure('editor.keystroke.latency', 1.5, { language: 'typescript' })
    reporter.measure('editor.build', 12)
    await reporter.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('/telemetry')
    expect(sent[0]?.body.measurements).toEqual([
      { name: 'editor.keystroke.latency', value: 1.5, attrs: { language: 'typescript' } },
      { name: 'editor.build', value: 12, attrs: {} },
    ])
  })

  test('sends nothing at all when nothing was measured', async () => {
    const sent = capturing()
    await createReporter().flush()
    expect(sent).toEqual([])
  })

  /** A batch sent twice would double every count in the backend. */
  test('does not send the same measurement twice', async () => {
    const sent = capturing()
    const reporter = createReporter()

    reporter.measure('editor.build', 12)
    await reporter.flush()
    await reporter.flush()

    expect(sent).toHaveLength(1)
  })

  test('keeps measuring after a failed send, without throwing', async () => {
    const sent = capturing(false)
    const reporter = createReporter()

    reporter.measure('editor.build', 12)
    await reporter.flush()

    reporter.measure('editor.build', 13)
    await reporter.flush()

    expect(sent).toHaveLength(2)
  })

  /**
   * The case that matters for a long session against a collector that is not there: typing must
   * not grow an array forever.
   */
  test('discards the oldest measurements rather than growing without bound', async () => {
    const sent = capturing()
    const reporter = createReporter()

    for (let i = 0; i < MAX_BUFFERED + 50; i++) reporter.measure('editor.build', i)
    await reporter.flush()

    const measurements = sent[0]?.body.measurements ?? []
    expect(measurements).toHaveLength(MAX_BUFFERED)
    // The newest are what a reader cares about, so it is the oldest that go.
    expect(measurements[measurements.length - 1]?.value).toBe(MAX_BUFFERED + 49)
  })

  test('flushes on its own once the interval passes', async () => {
    const sent = capturing()
    const reporter = createReporter({ intervalMs: 5 })
    try {
      reporter.measure('editor.build', 12)
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(sent).toHaveLength(1)
    } finally {
      reporter.stop()
    }
  })

  test('stops flushing once stopped, so a closed editor makes no requests', async () => {
    const sent = capturing()
    const reporter = createReporter({ intervalMs: 5 })

    reporter.stop()
    reporter.measure('editor.build', 12)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(sent).toEqual([])
  })
})
