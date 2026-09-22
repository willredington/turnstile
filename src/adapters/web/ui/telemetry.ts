/**
 * The editor's side of the measurement bridge.
 *
 * Keystroke latency is the figure the move to CodeMirror was about, and it can only be timed
 * where the keystroke lands. A request per keystroke would cost more than the thing it measures,
 * so measurements buffer here and go out in batches to `/telemetry`, where the server validates
 * them and exports them alongside everything else.
 *
 * Deliberately not an OpenTelemetry browser SDK: that is a large bundle to ship into the page to
 * do what one `fetch` of an array does, and the server is already an OTLP exporter.
 */

/**
 * How many measurements are held before the oldest start being dropped.
 *
 * Bounded because the interesting failure is a long session against a collector that is not
 * listening: every flush fails, nothing drains, and an unbounded buffer would turn typing into
 * a memory leak. Dropping the oldest is right — recent latency is what anyone looks at.
 */
export const MAX_BUFFERED = 512

/** How often the buffer is drained. */
const DEFAULT_INTERVAL_MS = 5_000

type Measurement = { name: string; value: number; attrs: Record<string, string> }

export type Reporter = {
  /** Note one measurement. Never blocks, never throws, never makes a request by itself. */
  measure(name: string, value: number, attrs?: Record<string, string>): void
  /** Send whatever is buffered now. */
  flush(): Promise<void>
  /** Stop the periodic flush — for when the editor goes away. */
  stop(): void
}

export function createReporter(options: { intervalMs?: number } = {}): Reporter {
  let buffered: Measurement[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  const flush = async (): Promise<void> => {
    if (buffered.length === 0) return
    // Taken before the request, so a measurement made while it is in flight is not lost, and a
    // failed request does not resend a batch the server may already have counted.
    const batch = buffered
    buffered = []
    await fetch('/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measurements: batch }),
    }).catch(() => {
      // A measurement is never worth surfacing an error for. The batch is gone; the next one
      // will carry the state of the world just as well.
    })
  }

  timer = setInterval(() => {
    void flush()
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS)

  return {
    measure(name, value, attrs) {
      if (timer === null) return
      buffered.push({ name, value, attrs: attrs ?? {} })
      if (buffered.length > MAX_BUFFERED) buffered = buffered.slice(-MAX_BUFFERED)
    },
    flush,
    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}

let shared: Reporter | null = null

/**
 * The page's one reporter.
 *
 * Lazy rather than a module constant so that importing this module — which the tests do — does
 * not start an interval timer. Created on first use and left running for the page's lifetime:
 * editors come and go as files are opened, and a reporter per editor would batch nothing.
 *
 * The `pagehide` flush is what stops the last few seconds of measurements being lost every time
 * the tab is closed. It is verified in the live smoke test rather than a unit test — there is no
 * honest way to fake a page unload.
 */
export function sharedReporter(): Reporter {
  if (shared !== null) return shared
  shared = createReporter()
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void shared?.flush()
    })
  }
  return shared
}
