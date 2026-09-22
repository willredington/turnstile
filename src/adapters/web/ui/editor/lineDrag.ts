import type { EditorState, Extension } from '@codemirror/state'
import { type EditorView, lineNumbers } from '@codemirror/view'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Dragging the line numbers to pick whole lines — the gesture both a note and a question start
 * from.
 *
 * It used to be dragging over the text, which was unambiguous while the document was read-only
 * and is not any more: selecting code is how you edit it. The gutter is the one strip that has
 * no editing meaning, and dragging it to pick whole lines is what every other editor already
 * does.
 *
 * Shared by both document surfaces. Without that, asking about code would only work on files
 * the agent happened to change, which is the wrong half of the repository.
 */

/** The lines a gesture picked, and what they say. */
export type Pending = {
  rangeStart: number
  line: number
  /**
   * Which verb the gesture was reaching for, so the composer can lead with it.
   *
   * Both are always offered — a selection can become either — but a reader who pressed "Ask"
   * beside their selection should not then have to find Ask again among the buttons.
   */
  intent: 'note' | 'ask'
  /**
   * The lines a note or question is about, verbatim.
   *
   * Never truncated: for a note this exact string is what `core/annotations.ts` later compares
   * against the file to decide whether it still points at what it was written about, so an
   * elision would retire every long note the moment it was written.
   */
  quote: string
}

/** Select whole lines `a` through `b`, in either drag direction. */
function selectLines(view: EditorView, a: number, b: number): void {
  const total = view.state.doc.lines
  const clamp = (line: number): number => Math.max(1, Math.min(total, line))
  const from = view.state.doc.line(clamp(Math.min(a, b))).from
  const to = view.state.doc.line(clamp(Math.max(a, b))).to
  view.dispatch({ selection: { anchor: from, head: to } })
}

function quoteOf(state: EditorState, from: number, to: number): string {
  const lines: string[] = []
  for (let n = from; n <= to && n <= state.doc.lines; n += 1) lines.push(state.doc.line(n).text)
  return lines.join('\n')
}

export type LineDrag = {
  /** The `lineNumbers()` extension to put in the view's extension list. */
  extension: Extension
  /** What the last completed drag picked, or null once it has been acted on or dismissed. */
  pending: Pending | null
  setPending: (pending: Pending | null) => void
}

/**
 * @param view the live editor, which does not exist until the build effect has run
 */
export function useLineDrag(view: RefObject<EditorView | null>): LineDrag {
  const [pending, setPending] = useState<Pending | null>(null)
  /** Where a gutter drag started, while the button is still down. */
  const anchor = useRef<number | null>(null)

  // Built once: the handler reads the anchor through a ref, so it never goes stale, and a new
  // extension object per render would rebuild the gutter for nothing.
  const extension = useMemo(
    () =>
      lineNumbers({
        domEventHandlers: {
          mousedown: (current, block, event) => {
            if ((event as MouseEvent).button !== 0) return false
            const at = current.state.doc.lineAt(block.from).number
            anchor.current = at
            selectLines(current, at, at)
            event.preventDefault()
            return true
          },
        },
      }),
    [],
  )

  /**
   * The rest of the drag: extend while the button is down, settle on release.
   *
   * Listens on the window rather than the editor, so a drag that wanders off the gutter — or
   * off the pane entirely — still ends somewhere.
   *
   * The view is read inside the handlers rather than captured when the listeners are attached.
   * It has to be: this hook is called before the effect that builds the view, so hook order
   * puts this effect first and `view.current` is still null at that point. Capturing it here
   * would attach nothing and never run again, which looks exactly like a gutter that has
   * stopped responding — selection still paints, because that is the gutter's own mousedown
   * handler, but no drag ever settles.
   */
  useEffect(() => {
    const lineAt = (current: EditorView, event: MouseEvent): number | null => {
      const pos = current.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      return pos === null ? null : current.state.doc.lineAt(pos).number
    }

    const onMove = (event: MouseEvent): void => {
      const current = view.current
      const from = anchor.current
      if (current === null || from === null) return
      const line = lineAt(current, event)
      if (line !== null) selectLines(current, from, line)
    }

    const onUp = (event: MouseEvent): void => {
      const current = view.current
      const from = anchor.current
      if (current === null || from === null) return
      anchor.current = null
      const line = lineAt(current, event) ?? from
      const start = Math.min(from, line)
      const end = Math.max(from, line)
      setPending({
        rangeStart: start,
        line: end,
        quote: quoteOf(current.state, start, end),
        intent: 'note',
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [view])

  return { extension, pending, setPending }
}
