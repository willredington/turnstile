import type { Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Reporter } from '../telemetry.ts'

/**
 * Timing what an edit costs, from inside CodeMirror's own dispatch.
 *
 * The figure that decided this editor's architecture was per-keystroke cost — 1.2 ms against the
 * hand-rolled viewer's 270 ms — and it was measured once, in a spike that no longer exists.
 * This keeps measuring it, so a regression shows up as a number rather than as a feeling that
 * typing has got worse.
 *
 * Wrapping `dispatchTransactions` means every edit in the editor goes through here, so the first
 * duty is to apply the transactions unconditionally: a throw or an early return here would stop
 * the editor accepting input at all.
 *
 * It deliberately does not force a layout to measure. The spike did, which made its numbers
 * pessimistic but complete; doing it on every real keystroke would slow down the thing being
 * measured. What this reports is the cost of applying the transaction and CodeMirror's own DOM
 * update — the part that scaled badly before.
 */
export function timedDispatch(
  reporter: Reporter,
  attrs: Record<string, string>,
): (transactions: readonly Transaction[], view: EditorView) => void {
  return (transactions, view) => {
    // Selection moves and decoration pushes are not keystrokes, and counting them would bury
    // the edits that actually cost something under a pile of near-zero samples.
    if (!transactions.some((transaction) => transaction.docChanged)) {
      view.update(transactions)
      return
    }

    const started = performance.now()
    try {
      view.update(transactions)
    } finally {
      reporter.measure('editor.keystroke.latency', performance.now() - started, attrs)
    }
  }
}
