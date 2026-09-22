import { describe, expect, test } from 'bun:test'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  editableIn,
  reconfigureEditable,
} from '../../../../src/adapters/web/ui/editor/useSaveable.ts'

/**
 * Turning editing on after the editor already exists.
 *
 * Whether a file can be edited is not known when its view is built: a file opened from the tree
 * is read-only until a session opens, and the session opens on the first prompt — by which time
 * the view has been constructed. Baking `EditorView.editable` into the initial configuration meant
 * the pane stayed read-only until it was destroyed and rebuilt, which is what clicking to another
 * file and back did. That is the bug this exists to prevent.
 *
 * Reconfiguring rather than rebuilding, because a rebuild discards the cursor, the scroll position
 * and the undo history — and would drop unsaved work outright.
 *
 * Tested against a real `EditorState`, with no DOM: `EditorView.editable` is a facet, so its value
 * can be read straight off the state.
 */

function stateWith(editable: boolean): { state: EditorState; compartment: Compartment } {
  const compartment = new Compartment()
  const state = EditorState.create({
    doc: 'export const a = 1\n',
    extensions: [editableIn(compartment, editable)],
  })
  return { state, compartment }
}

describe('switching editing on and off', () => {
  test('starts read-only when it was built read-only', () => {
    const { state } = stateWith(false)
    expect(state.facet(EditorView.editable)).toBe(false)
  })

  test('starts editable when it was built editable', () => {
    const { state } = stateWith(true)
    expect(state.facet(EditorView.editable)).toBe(true)
  })

  /** The one that was broken: a session opening has to reach a view that already exists. */
  test('becomes editable without rebuilding, once a session opens', () => {
    const { state, compartment } = stateWith(false)

    const next = state.update({ effects: reconfigureEditable(compartment, true) }).state

    expect(next.facet(EditorView.editable)).toBe(true)
  })

  test('goes back to read-only the same way', () => {
    const { state, compartment } = stateWith(true)

    const next = state.update({ effects: reconfigureEditable(compartment, false) }).state

    expect(next.facet(EditorView.editable)).toBe(false)
  })

  /** Reconfiguring must not disturb the document — that is the whole point of not rebuilding. */
  test('keeps the document it was holding', () => {
    const { state, compartment } = stateWith(false)

    const next = state.update({ effects: reconfigureEditable(compartment, true) }).state

    expect(next.doc.toString()).toBe('export const a = 1\n')
  })

  test('keeps unsaved edits across the switch', () => {
    const { state, compartment } = stateWith(true)
    const typed = state.update({ changes: { from: 0, insert: '// mine\n' } }).state

    const next = typed.update({ effects: reconfigureEditable(compartment, false) }).state

    expect(next.doc.toString()).toStartWith('// mine')
  })
})
