import { Compartment, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Editing a file, and the bookkeeping that keeps the reader's work safe.
 *
 * Shared by both document surfaces — the changed file under review and a file opened from the
 * project tree — so that "unsaved", "the file moved underneath you" and "the save was refused"
 * mean the same thing and are handled once. Growing a second copy of this in the other surface
 * is how the two would drift into disagreeing about whether work is on disk.
 */
/**
 * Whether the file can be edited, in a compartment so it can be changed later.
 *
 * Not baked into the initial configuration, because whether a file is editable is not known when
 * its view is built: a file opened from the project tree is read-only until a session opens, and
 * the session opens on the first prompt — by which time the view exists. Configured once at
 * construction, the pane stayed read-only until it was destroyed and rebuilt, which is what
 * clicking away to another file and back happened to do.
 */
export function editableIn(compartment: Compartment, editable: boolean): Extension {
  return compartment.of(EditorView.editable.of(editable))
}

/**
 * Switch editing on or off in a view that already exists.
 *
 * A reconfiguration rather than a rebuild: rebuilding discards the cursor, the scroll position and
 * the undo history, and would throw away unsaved work outright.
 */
export function reconfigureEditable(
  compartment: Compartment,
  editable: boolean,
): StateEffect<unknown> {
  return compartment.reconfigure(EditorView.editable.of(editable))
}

export type Saveable = {
  /** The live view. The surface that builds it assigns this. */
  view: MutableRefObject<EditorView | null>
  /** What the document was last set from — a load, or the reader's own save. Unsaved typing
   *  moves the document away from this, which is exactly what `dirty` means. */
  synced: MutableRefObject<string | null>
  dirty: boolean
  /** The file changed on disk while there was unsaved work in it. */
  conflict: boolean
  /** Why the last save did not land, if it did not. */
  refusal: string | null
  editable: boolean
  save: () => Promise<void>
  /** Extensions that make ⌘S and dirty-tracking work. */
  extensions: Extension[]
  /**
   * Whether incoming text may replace the document.
   *
   * False while there is unsaved work: replacing it would throw that work away without
   * asking, so unsaved typing always wins the race and the reader is told the file moved.
   */
  shouldAccept: (text: string) => boolean
}

export function useSaveable(onSave?: (text: string) => Promise<void> | void): Saveable {
  const view = useRef<EditorView | null>(null)
  const synced = useRef<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const save = useCallback(async (): Promise<void> => {
    const current = view.current
    const write = onSaveRef.current
    if (current === null || write === undefined) return
    const next = current.state.doc.toString()
    try {
      await write(next)
    } catch (error) {
      // The work stays on screen and stays dirty. Saying nothing here is how it gets lost.
      setRefusal(error instanceof Error ? error.message : String(error))
      return
    }
    synced.current = next
    setDirty(false)
    setConflict(false)
    setRefusal(null)
  }, [])

  const shouldAccept = useCallback((text: string): boolean => {
    if (!dirtyRef.current) return true
    if (text !== synced.current) setConflict(true)
    return false
  }, [])

  const editable = onSave !== undefined
  const editableCompartment = useMemo(() => new Compartment(), [])

  // A session opening flips this long after the view was built, so the change has to reach the
  // live view rather than waiting for the next one.
  useEffect(() => {
    const current = view.current
    if (current === null) return
    current.dispatch({ effects: reconfigureEditable(editableCompartment, editable) })
  }, [editable, editableCompartment])

  const extensions: Extension[] = [
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void save()
          return true
        },
      },
    ]),
    editableIn(editableCompartment, editable),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) setDirty(update.state.doc.toString() !== synced.current)
    }),
  ]

  return { view, synced, dirty, conflict, refusal, editable, save, extensions, shouldAccept }
}
