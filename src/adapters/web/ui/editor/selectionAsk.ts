import type { Extension, SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Selecting code with the cursor and asking about it.
 *
 * The gutter drag stays what it is — the way you pick whole lines to note or ask about. This is
 * the other instinct, and the more common one: you highlight the thing you are looking at and
 * want to know about *that*.
 *
 * Both document surfaces open the composer the moment a selection is made — through
 * `markup.tsx`, so a note or a question either way, changed file or not. The plan document opens
 * its own question box instead. A button to press first was tried and read as a step that
 * decided nothing.
 *
 * Appears on release rather than on every selection change, so dragging across twenty lines
 * does not strobe a box along behind the cursor. Keyboard selection (shift+arrows) has no
 * release to wait for, so it shows as soon as the selection is non-empty — unless `mouseOnly`
 * says it should not count at all.
 */

/** Whether a mouse button is currently down anywhere, so a selection mid-drag stays quiet. */
let pressed = false
if (typeof window !== 'undefined') {
  window.addEventListener('mousedown', () => {
    pressed = true
  })
  window.addEventListener('mouseup', () => {
    pressed = false
  })
}

type SelectedText = {
  /** First and last line the selection touches, whole lines, as an ask is anchored. */
  rangeStart: number
  line: number
  quote: string
  /** Where to put the affordance, in viewport coordinates. */
  left: number
  top: number
}

const keyOf = (range: SelectionRange): string => `${range.from}-${range.to}`

function readSelection(view: EditorView): SelectedText | null {
  const { main } = view.state.selection
  if (main.empty) return null

  const doc = view.state.doc
  const rangeStart = doc.lineAt(main.from).number
  const line = doc.lineAt(main.to).number
  const lines: string[] = []
  for (let n = rangeStart; n <= line; n += 1) lines.push(doc.line(n).text)

  // Beside where the selection ends, not under it: the end of a selected line is usually
  // empty space, while the line below it is code the reader is still trying to see.
  const coords = view.coordsAtPos(main.to)
  if (coords === null) return null
  return { rangeStart, line, quote: lines.join('\n'), left: coords.right, top: coords.top }
}

export type SelectionAsk = {
  extension: Extension
  selected: SelectedText | null
  /** Done with this selection — and do not raise it again until a different one is made. */
  clear: () => void
}

/**
 * @param view    the live editor, which does not exist until the build effect has run
 * @param handOff whether raising a selection should also hand focus over — true where the
 *                selection opens a box to type in straight away, false where it only raises a
 *                button and the reader may well carry on editing
 * @param mouseOnly whether only a selection made with the mouse counts. Where a selection opens
 *                a box straight away, shift+arrow would open it on the first keypress, while the
 *                reader is still extending a selection they mean to edit
 */
export function useSelectionAsk(
  view: RefObject<EditorView | null>,
  handOff = false,
  mouseOnly = false,
): SelectionAsk {
  const [selected, setSelected] = useState<SelectedText | null>(null)

  /**
   * The selection already acted on.
   *
   * Without this, asking reopens itself: the answer card is a block widget, inserting it
   * changes the document's geometry, that is an editor update, and the update re-reads a
   * selection which is still exactly where it was. The reader gets the box back the moment
   * they are rid of it. Cleared by any *different* selection, so asking twice about the same
   * lines still works — you just have to select them again.
   */
  const dismissed = useRef<string | null>(null)

  const show = useCallback(
    (current: EditorView | null) => {
      if (current === null) return
      if (pressed) {
        // Still being made: a target that chases the cursor is worse than none.
        setSelected(null)
        return
      }
      const next =
        keyOf(current.state.selection.main) === dismissed.current ? null : readSelection(current)
      /**
       * Let go of the editor here, before React has even rendered the box.
       *
       * CodeMirror re-asserts DOM focus on its content whenever it writes its selection back to
       * the DOM, and it does that for as long as it believes it is focused. A box that focuses
       * itself in an effect loses that race every time — effects of a child run before its
       * parent's, so any blur arranged up there happens too late. Doing it while handling the
       * event that raised the selection is early enough for the box's own focus to stick.
       */
      if (handOff && next !== null) current.contentDOM.blur()
      setSelected(next)
    },
    [handOff],
  )

  const clear = useCallback(() => {
    const current = view.current
    dismissed.current = current === null ? null : keyOf(current.state.selection.main)
    setSelected(null)
  }, [view])

  /** Built once — it closes over nothing that changes. */
  const extension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged && !update.geometryChanged) return
        if (update.selectionSet) dismissed.current = null
        // The release below is the only thing that raises a selection here.
        if (mouseOnly) return
        show(update.view)
      }),
    [show, mouseOnly],
  )

  // A selection finished with the mouse only settles on release, and no editor update
  // accompanies that — so the release is listened for directly.
  useEffect(() => {
    const onUp = (): void => {
      // After the browser has applied the release to the selection, not before.
      queueMicrotask(() => show(view.current))
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [view, show])

  useEffect(() => {
    const current = view.current
    if (current === null || selected === null) return
    const onScroll = (): void => show(current)
    current.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    return () => current.scrollDOM.removeEventListener('scroll', onScroll)
  }, [view, selected, show])

  return { extension, selected, clear }
}
