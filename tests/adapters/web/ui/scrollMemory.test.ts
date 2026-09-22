import { describe, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import {
  recallScroll,
  rememberScroll,
  type ScrollSnapshot,
} from '../../../../src/adapters/web/ui/editor/scrollMemory.ts'

/**
 * Where each tab was left. `EditorView.scrollIntoView` is a static that builds the same kind of
 * effect `scrollSnapshot()` returns — a `ScrollTarget` one — without needing a view, so it
 * stands in for one here. The cast is because it is declared `StateEffect<unknown>` and
 * `ScrollTarget` is not exported, so there is no way to say what it really is.
 */
const snapshotAt = (pos: number) => EditorView.scrollIntoView(pos) as ScrollSnapshot

describe('where each tab was scrolled to', () => {
  test('a tab nobody has scrolled has nothing to go back to', () => {
    expect(recallScroll('never-opened.ts')).toBeUndefined()
  })

  test('what was remembered under a key comes back under it', () => {
    const snapshot = snapshotAt(120)
    rememberScroll('a.ts', snapshot)
    expect(recallScroll('a.ts')).toBe(snapshot)
  })

  test('scrolling again replaces where it was, rather than stacking up', () => {
    rememberScroll('b.ts', snapshotAt(10))
    const later = snapshotAt(4000)
    rememberScroll('b.ts', later)
    expect(recallScroll('b.ts')).toBe(later)
  })

  // The board's row and the reader's row key differently on purpose; this is the property
  // that makes two tabs on the same file keep their own places.
  test('two tabs do not see each other', () => {
    const board = snapshotAt(1)
    const reader = snapshotAt(2)
    rememberScroll('/repo\0c.ts', board)
    rememberScroll('c.ts', reader)
    expect(recallScroll('/repo\0c.ts')).toBe(board)
    expect(recallScroll('c.ts')).toBe(reader)
  })
})
