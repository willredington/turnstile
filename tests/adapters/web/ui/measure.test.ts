import { describe, expect, test } from 'bun:test'
import { EditorState, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { timedDispatch } from '../../../../src/adapters/web/ui/editor/measure.ts'

/**
 * Timing a keystroke.
 *
 * This wraps CodeMirror's own dispatch, which makes it the one place where getting it wrong
 * would break editing rather than merely mismeasure it — so what is asserted first is that every
 * transaction still reaches the view.
 *
 * Real transactions, built from a real `EditorState`, because `docChanged` is the thing being
 * branched on and a hand-made stub would just agree with whatever the code did.
 */

const state = EditorState.create({ doc: 'export const value = 1\n' })

/** A view that records what it was asked to apply. No DOM: `update` is all this calls. */
function fakeView(): { view: EditorView; applied: readonly Transaction[][] } {
  const applied: readonly Transaction[][] = []
  const view = {
    update: (trs: readonly Transaction[]) => {
      ;(applied as Transaction[][]).push([...trs])
    },
  } as unknown as EditorView
  return { view, applied }
}

const edit = (): Transaction => state.update({ changes: { from: 0, insert: 'x' } })
const moveCursor = (): Transaction => state.update({ selection: { anchor: 3 } })

describe('timing a dispatch', () => {
  test('applies the transactions it was given', () => {
    const { view, applied } = fakeView()
    const transaction = edit()

    timedDispatch(fakeReporter(), {})([transaction], view)

    expect(applied).toEqual([[transaction]])
  })

  test('applies a selection change too, even though it measures nothing', () => {
    const { view, applied } = fakeView()

    timedDispatch(fakeReporter(), {})([moveCursor()], view)

    expect(applied).toHaveLength(1)
  })

  test('measures an edit as keystroke latency', () => {
    const reporter = fakeReporter()
    const { view } = fakeView()

    timedDispatch(reporter, { language: 'typescript' })([edit()], view)

    expect(reporter.measured).toHaveLength(1)
    expect(reporter.measured[0]?.name).toBe('editor.keystroke.latency')
    expect(reporter.measured[0]?.attrs).toEqual({ language: 'typescript' })
    expect(reporter.measured[0]?.value).toBeGreaterThanOrEqual(0)
  })

  /** Moving the cursor costs nothing worth a histogram, and would bury the edits that do. */
  test('measures nothing when no transaction changed the document', () => {
    const reporter = fakeReporter()
    const { view } = fakeView()

    timedDispatch(reporter, {})([moveCursor()], view)

    expect(reporter.measured).toEqual([])
  })

  test('measures once for a batch that changed the document', () => {
    const reporter = fakeReporter()
    const { view } = fakeView()

    timedDispatch(reporter, {})([moveCursor(), edit()], view)

    expect(reporter.measured).toHaveLength(1)
  })
})

/** A `Reporter` that remembers what it was told, standing in for the batching one. */
function fakeReporter(): {
  measured: { name: string; value: number; attrs: Record<string, string> }[]
  measure: (name: string, value: number, attrs?: Record<string, string>) => void
  flush: () => Promise<void>
  stop: () => void
} {
  const measured: { name: string; value: number; attrs: Record<string, string> }[] = []
  return {
    measured,
    measure: (name, value, attrs) => measured.push({ name, value, attrs: attrs ?? {} }),
    flush: async () => {},
    stop: () => {},
  }
}
