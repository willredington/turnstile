import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, type EditorView } from '@codemirror/view'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { anchorLabel } from '../../../../core/ask.ts'
import type { Annotation } from '../../../../core/types.ts'
import { AskThread } from './AskThread.tsx'
import { askedLines, headerDecoration } from './decorations.ts'
import { type HostRegistry, HostWidget } from './hosts.tsx'
import { type Pending, useLineDrag } from './lineDrag.ts'
import { Composer, NoteBand, type NoteTarget } from './parts.tsx'
import { useSelectionAsk } from './selectionAsk.ts'
import type { Ask } from './useAsk.ts'

/**
 * What the reader writes on a file — notes and questions — and the two gestures that start
 * either: dragging the line numbers, and highlighting code.
 *
 * Shared by both document surfaces so that marking up a file works the same whether or not the
 * agent touched it. It used to be written twice, and the copies drifted: a file opened from the
 * tree offered only a question, on the grounds that a note on a file not on the board would never
 * be seen again. It is seen — a note goes to the agent with its path and lines like any other —
 * and the difference was just one more thing for the reader to learn.
 *
 * Each surface keeps what is its own (bands, folds, removals, findings) and asks this for the
 * rest: the extensions, the decorations, and what goes in each widget.
 */

/** A removal a note on an old-side line rides with. Only the board's document has these. */
type NoteRemoval = { line: number; oldLines: readonly number[] }

const NO_REMOVALS: readonly NoteRemoval[] = []

export type Markup = {
  /** The gutter drag and the cursor selection, for the view's extension list. */
  extensions: Extension[]
  pending: Pending | null
  /** The notes, questions and composer for the document as it now stands. Changes identity
   *  exactly when what it would return does, so it can stand in an effect's dependencies. */
  decorate: (state: EditorState) => Range<Decoration>[]
  /** What belongs in one of this layer's widgets, or null for an id that is not one of them. */
  portal: (id: string) => ReactNode | null
}

/**
 * @param notes    where notes go. Absent means the file cannot take one (no session yet), and the
 *                 composer offers only a question
 * @param removals where a note on a removed line should be shown, since its old-side number is
 *                 not a line the file has
 */
export function useMarkup(
  view: RefObject<EditorView | null>,
  registry: HostRegistry,
  notes: NoteTarget | undefined,
  asking: Ask,
  removals: readonly NoteRemoval[] = NO_REMOVALS,
): Markup {
  const { extension: gutter, pending, setPending } = useLineDrag(view)
  const {
    extension: cursorSelect,
    selected,
    clear: clearSelection,
  } = useSelectionAsk(view, true, true)
  const [draft, setDraft] = useState('')

  // Highlighting code opens the composer on it straight away — the same box a gutter drag
  // opens, offering both a note and a question. A new highlight while one is open retargets it,
  // the way a new drag does.
  useEffect(() => {
    if (selected === null) return
    setPending({
      rangeStart: selected.rangeStart,
      line: selected.line,
      quote: selected.quote,
      intent: 'note',
    })
    clearSelection()
  }, [selected, setPending, clearSelection])

  // A fresh drag starts a fresh note. Adjusted during render rather than in an effect so the
  // composer never paints with the previous selection's half-typed text in it.
  const drafted = useRef<Pending | null>(null)
  if (drafted.current !== pending) {
    drafted.current = pending
    setDraft('')
  }

  const annotations = notes?.annotations
  const noteAt = useMemo(() => {
    const byNewLine = new Map<number, Annotation[]>()
    for (const annotation of annotations ?? []) {
      if (annotation.side !== 'new') continue
      const at = byNewLine.get(annotation.line) ?? []
      at.push(annotation)
      byNewLine.set(annotation.line, at)
    }
    // A note left on a removed line has an old-side number, which is not a line the file has.
    // It rides with the removal it was written about.
    for (const removal of removals) {
      for (const annotation of annotations ?? []) {
        if (annotation.side !== 'old') continue
        if (!removal.oldLines.includes(annotation.line)) continue
        const at = byNewLine.get(removal.line) ?? []
        at.push(annotation)
        byNewLine.set(removal.line, at)
      }
    }
    return byNewLine
  }, [annotations, removals])

  const threads = asking.threads
  const decorate = useCallback(
    (state: EditorState): Range<Decoration>[] => {
      const out: Range<Decoration>[] = []
      for (const line of noteAt.keys()) {
        if (line > state.doc.lines) continue
        out.push(
          Decoration.widget({
            widget: new HostWidget(`notes:${line}`, 'ts-note-host', registry),
            block: true,
            side: 1,
          }).range(state.doc.line(line).to),
        )
      }
      for (const thread of threads) {
        // A question about the whole file rides at the top, beside any file-level findings; one
        // about a range sits under its last line, in the same slot family as a note.
        if (thread.anchor === null) {
          out.push(headerDecoration(new HostWidget(`ask:${thread.id}`, 'ts-ask-host', registry)))
          continue
        }
        if (thread.anchor.endLine > state.doc.lines) continue
        out.push(
          Decoration.widget({
            widget: new HostWidget(`ask:${thread.id}`, 'ts-ask-host', registry),
            block: true,
            side: 1,
          }).range(state.doc.line(thread.anchor.endLine).to),
          // The lines the card is about, still marked as the lines the card is about — the card
          // used to reprint them instead, a few pixels under the originals.
          ...askedLines(state, thread.anchor),
        )
      }
      if (pending !== null && pending.line <= state.doc.lines) {
        out.push(
          Decoration.widget({
            widget: new HostWidget('composer', 'ts-composer-host', registry),
            block: true,
            side: 2,
          }).range(state.doc.line(pending.line).to),
          ...askedLines(state, { startLine: pending.rangeStart, endLine: pending.line }),
        )
      }
      return out
    },
    [noteAt, threads, pending, registry],
  )

  const portal = (id: string): ReactNode | null => {
    if (id.startsWith('notes:')) {
      if (notes === undefined) return null
      const line = Number(id.slice('notes:'.length))
      return (noteAt.get(line) ?? []).map((annotation) => (
        <NoteBand key={annotation.id} annotation={annotation} onRemove={notes.onRemove} />
      ))
    }
    if (id.startsWith('ask:')) {
      const thread = threads.find((candidate) => `ask:${candidate.id}` === id)
      if (thread === undefined) return null
      return (
        <AskThread
          thread={thread}
          onFollow={(question) => asking.follow(thread.id, question)}
          onClose={() => asking.close(thread.id)}
        />
      )
    }
    if (id === 'composer' && pending !== null) {
      return (
        <Composer
          state={{
            rangeLabel: anchorLabel({ startLine: pending.rangeStart, endLine: pending.line }),
            // Without somewhere to put a note, a question is all the lines can become.
            intent: notes === undefined ? 'ask' : pending.intent,
            draft,
            onDraftChange: setDraft,
            onCancel: () => setPending(null),
            onSave:
              notes === undefined
                ? undefined
                : () => {
                    notes.onAdd(
                      pending.rangeStart,
                      pending.line,
                      'new',
                      pending.quote,
                      draft.trim(),
                    )
                    setPending(null)
                  },
            onAsk: () => {
              asking.ask(
                { startLine: pending.rangeStart, endLine: pending.line },
                pending.quote,
                draft.trim(),
              )
              setPending(null)
            },
          }}
        />
      )
    }
    return null
  }

  return { extensions: [gutter, cursorSelect], pending, decorate, portal }
}
