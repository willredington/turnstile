import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { blocksUnder, planBlocks, quotedLines } from '../../../core/planBlocks.ts'
import type { Annotation } from '../../../core/types.ts'
import { Composer, NoteBand, SelectionQuestion } from './editor/parts.tsx'
import { Markdown } from './Markdown.tsx'

/**
 * The rendered text of `root`, with a map from each character back to where it came from.
 *
 * Whitespace collapses because a selection's own text does: a paragraph wrapped across three
 * source lines is one run of words on screen, and matching the two has to agree about that.
 */
function textIndex(root: HTMLElement): { text: string; at: { node: Text; offset: number }[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  const at: { node: Text; offset: number }[] = []
  let space = true
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const chunk = node.textContent ?? ''
    for (let i = 0; i < chunk.length; i += 1) {
      const blank = /\s/.test(chunk[i] ?? '')
      if (blank && space) continue
      text += blank ? ' ' : chunk[i]
      at.push({ node: node as Text, offset: i })
      space = blank
    }
  }
  return { text, at }
}

/** A live range over `quote` wherever it appears in `root`, or null if it no longer does. */
function rangeOfQuote(root: HTMLElement, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, ' ').trim()
  if (needle === '') return null
  const { text, at } = textIndex(root)
  const found = text.indexOf(needle)
  if (found === -1) return null
  const start = at[found]
  const end = at[found + needle.length - 1]
  if (start === undefined || end === undefined) return null

  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
}

/**
 * Keep the words a note is about visible while the note box is open.
 *
 * The browser paints a selection only in the focused element, so the moment the box takes the
 * cursor the highlight vanishes — and with it any sight of what the note is about. The document
 * surface hit this first and answered it with `askedLines`, which marks the lines a question is
 * about rather than relying on the browser's own highlight. This is the same answer for prose.
 *
 * Painted through the CSS Custom Highlight API, which colours a range without touching the DOM.
 * Wrapping the words in a `<mark>` would rewrite the markdown React just rendered — and
 * invalidate the very range being painted.
 *
 * **The range is rebuilt from the quoted text on every paint, never stored.** A `Range` held
 * across a render is a reference into DOM that React owns and replaces: measured here, opening
 * the note box swapped the paragraph node out from under a cloned range and collapsed it to a
 * point, so the highlight silently painted nothing. Finding the words again cannot go stale
 * that way.
 */
function usePaintedSelection(root: RefObject<HTMLElement | null>, quote: string | null): void {
  useEffect(() => {
    const registry = (
      CSS as unknown as {
        highlights?: { set(k: string, v: unknown): void; delete(k: string): void }
      }
    ).highlights
    const Painted = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
      .Highlight
    if (registry === undefined || Painted === undefined) return

    const paint = (): void => {
      const container = root.current
      const range = container === null || quote === null ? null : rangeOfQuote(container, quote)
      if (range === null) {
        registry.delete(HIGHLIGHT)
        return
      }
      registry.set(HIGHLIGHT, new Painted(range))
    }

    paint()
    if (quote === null) return
    // Painted again whenever the rendered document changes underneath it — which is exactly
    // what opening the box does, by re-rendering the block it sits under.
    const watching = new MutationObserver(paint)
    if (root.current !== null) {
      watching.observe(root.current, { childList: true, subtree: true, characterData: true })
    }
    return () => {
      watching.disconnect()
      registry.delete(HIGHLIGHT)
    }
  }, [root, quote])
}

/** The name the stylesheet's `::highlight()` rule paints. */
const HIGHLIGHT = 'plan-annotating'

/** Lines a note names, as the reader sees them described. */
function rangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
}

/** What is being written, and about which lines. */
type Pending = {
  startLine: number
  endLine: number
  /** What the note will quote — the selected words, or the whole of the blocks dragged over. */
  quote: string
  /** Where a selection put it, for the box that floats beside the text. Null for a margin drag,
   *  whose composer sits under the blocks instead. */
  at: { left: number; top: number } | null
}

/**
 * The plan, rendered.
 *
 * A plan is markdown and is read as markdown — headings, lists and prose. It was briefly shown
 * as its own source, in a code editor with line numbers, which put the one document in the app
 * that is pure prose behind a monospace gutter and made the reader parse `##` by eye.
 *
 * Two ways to object to part of it, because two instincts exist and neither is wrong:
 *
 *   - **Drag the margin** beside the blocks, the gesture the review surface uses.
 *   - **Highlight the words**, the gesture everything else in the world uses for a document.
 *
 * Both end at the same place: a note against a range of the plan's *source* lines. The reader
 * argues with the rendering; the agent is handed line numbers, because it wrote the plan as text
 * and is about to revise it as text.
 */
export function PlanDocument({
  plan,
  notes,
  onAnnotate,
  onRemoveNote,
}: {
  plan: string
  notes: Annotation[]
  onAnnotate: (rangeStart: number, line: number, lineText: string, body: string) => void
  onRemoveNote: (id: string) => void
}) {
  const blocks = useMemo(() => planBlocks(plan), [plan])
  const [pending, setPending] = useState<Pending | null>(null)
  const [draft, setDraft] = useState('')
  const root = useRef<HTMLDivElement>(null)

  // Letting go of a note lets go of its highlight wherever that happens — saved, cancelled,
  // dismissed, or replaced by the next gesture — because the paint follows `pending` itself.
  // Only a highlight paints: a margin drag has no words of its own, and the block tint says
  // what it covers.
  usePaintedSelection(root, pending?.at == null ? null : pending.quote)

  /**
   * The margin drag in progress: where it started, and the block it has reached.
   *
   * In a ref as well as in state because the window handlers below read it while it changes —
   * and mirrored into state because the blocks under it are tinted as you go.
   */
  const dragging = useRef<{ from: number; to: number } | null>(null)
  const [over, setOver] = useState<{ from: number; to: number } | null>(null)

  // A fresh gesture starts a fresh note. Adjusted during render rather than in an effect, so the
  // box never paints with the previous selection's half-typed text in it.
  const drafted = useRef<Pending | null>(null)
  if (drafted.current !== pending) {
    drafted.current = pending
    setDraft('')
  }

  const linesOf = useCallback(
    (from: number, to: number): string => {
      const covered = blocksUnder(blocks, Math.min(from, to), Math.max(from, to))
      return covered.map((block) => block.text).join('\n\n')
    },
    [blocks],
  )

  /**
   * Both gestures live here, in one place, so their order is decided deliberately rather than
   * by which effect happened to register first.
   *
   * A margin drag wins when there is one: it suppressed text selection at mousedown, so there
   * is nothing for the highlight branch to find anyway, and leaving that to chance is how two
   * notes get opened by one gesture.
   *
   * Both listen on the window rather than on the blocks, the same way the document's own gutter
   * drag does: a gesture that wanders out of the margin, or off the pane entirely, still tracks
   * and still ends somewhere.
   */
  useEffect(() => {
    /**
     * The block row the cursor is over, read from the event's own target rather than from each
     * row's `mouseenter` — which never fires once the cursor leaves the margin it started in.
     *
     * The target, not `elementFromPoint`. The browser has already hit-tested to deliver the
     * event, and it is the only answer that accounts for what is actually on top: the dev
     * server's own hot-reload element is a fixed, full-viewport node at the maximum z-index, so
     * `elementFromPoint` returns that and nothing else, for every point on the page.
     */
    const rowAt = (event: MouseEvent): { startLine: number; endLine: number } | null => {
      const row = event.target instanceof Element ? event.target.closest('[data-start-line]') : null
      if (!(row instanceof HTMLElement)) return null
      const startLine = Number(row.dataset.startLine)
      const endLine = Number(row.dataset.endLine)
      return Number.isFinite(startLine) && Number.isFinite(endLine) ? { startLine, endLine } : null
    }

    const onDown = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const on = event.target instanceof Element ? event.target.closest('.plan-margin') : null
      if (on === null) return
      const row = rowAt(event)
      if (row === null) return
      // Not a click: this stops the drag from starting a text selection as well, which would
      // leave both gestures running at once.
      event.preventDefault()
      const span = { from: row.startLine, to: row.endLine }
      dragging.current = span
      setOver(span)
    }

    const onMove = (event: MouseEvent): void => {
      const span = dragging.current
      if (span === null) return
      const row = rowAt(event)
      if (row === null || span.to === row.endLine) return
      const next = { from: span.from, to: row.endLine }
      dragging.current = next
      setOver(next)
    }

    const onUp = (event: MouseEvent): void => {
      const span = dragging.current
      if (span !== null) {
        dragging.current = null
        setOver(null)
        const startLine = Math.min(span.from, span.to)
        const endLine = Math.max(span.from, span.to)
        setPending({
          startLine,
          endLine,
          quote: linesOf(startLine, endLine),
          at: null,
        })
        return
      }

      // A highlight. Settled on release rather than on every selection change, so dragging
      // across three paragraphs does not strobe a box along behind the cursor. The selection
      // itself is left alone — the note is about those words, and collapsing them to open the
      // box would take away what the reader just pointed at.
      const container = root.current
      if (container === null) return
      if (event.target instanceof Node && !container.contains(event.target)) return

      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) return
      const text = selection.toString().trim()
      if (text === '') return

      const where = sourceSpan(selection, container)
      if (where === null) return

      // Narrow to the words actually highlighted. The block is the coarse answer — a six-step
      // list is one block — and a note that says "lines 11-16" when the reader pointed at step
      // three is exactly the imprecision this surface exists to remove.
      const covered = blocksUnder(blocks, where.startLine, where.endLine)
      const narrowed =
        covered.length === 1 && covered[0] !== undefined ? quotedLines(covered[0], text) : where

      const box = selection.getRangeAt(0).getBoundingClientRect()
      setPending({
        startLine: narrowed.startLine,
        endLine: narrowed.endLine,
        quote: text,
        at: { left: box.left, top: box.bottom + 6 },
      })
    }

    window.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [blocks, linesOf])

  const noted = useMemo(() => {
    const byBlock = new Map<string, Annotation[]>()
    for (const note of notes) {
      for (const block of blocksUnder(blocks, note.rangeStart, note.line)) {
        // A note that spans blocks rides under the last one it covers, so it reads as a remark
        // on the whole run rather than appearing three times.
        if (block.endLine < note.line && block !== blocks[blocks.length - 1]) continue
        const at = byBlock.get(block.key) ?? []
        at.push(note)
        byBlock.set(block.key, at)
      }
    }
    return byBlock
  }, [notes, blocks])

  /** Every block a note or the open composer covers, for tinting. */
  const marked = useMemo(() => {
    const keys = new Set<string>()
    for (const note of notes) {
      for (const block of blocksUnder(blocks, note.rangeStart, note.line)) keys.add(block.key)
    }
    return keys
  }, [notes, blocks])

  const selecting =
    over === null ? null : { from: Math.min(over.from, over.to), to: Math.max(over.from, over.to) }

  const save = (): void => {
    if (pending === null || draft.trim() === '') return
    onAnnotate(pending.startLine, pending.endLine, pending.quote, draft.trim())
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div className="plan-doc" ref={root}>
      {blocks.map((block) => {
        const under = noted.get(block.key) ?? []
        const inDrag =
          selecting !== null && block.startLine <= selecting.to && block.endLine >= selecting.from
        // Whatever the open note is about, marked for as long as it is open. A margin drag has
        // no text range to paint, and the painted range needs a fallback where the browser has
        // no `::highlight()` — either way, this says which part of the plan is in question.
        const annotating =
          pending !== null &&
          block.startLine <= pending.endLine &&
          block.endLine >= pending.startLine
        const composing =
          pending !== null &&
          pending.at === null &&
          block.endLine >= pending.endLine &&
          block.startLine <= pending.endLine
        return (
          <div
            key={block.key}
            className="plan-block-row"
            // Read back two ways: by `sourceSpan` walking up from a highlighted text node, and
            // by the drag's hit-testing. The rendered markdown carries no source positions of
            // its own, so they are written on here and recovered from both.
            data-start-line={block.startLine}
            data-end-line={block.endLine}
          >
            {/* The margin: the review surface's gesture, on a document with no line numbers to
                hang it off. A button rather than a bare div so it is reachable and says what it
                is; `preventDefault` keeps the drag from starting a text selection as well. */}
            <button
              type="button"
              className="plan-margin"
              aria-label={`Note ${rangeLabel(block.startLine, block.endLine)}`}
              title={`Drag to note ${rangeLabel(block.startLine, block.endLine)}`}
              // The gesture itself is handled on the window, not here, the same way the
              // document's gutter drag is: a drag that leaves the margin has to keep tracking,
              // and one handler that hit-tests the cursor does that where a per-button
              // `mouseenter` cannot.
            />
            <div
              className={`plan-block${marked.has(block.key) ? ' noted' : ''}${
                inDrag || annotating ? ' dragging' : ''
              }`}
            >
              <Markdown text={block.text} />
            </div>
            {under.length > 0 && (
              <div className="plan-block-notes">
                {under.map((note) => (
                  <NoteBand
                    key={note.id}
                    annotation={note}
                    state="goes back with the plan"
                    onRemove={onRemoveNote}
                  />
                ))}
              </div>
            )}
            {composing && (
              <div className="plan-block-notes">
                <Composer
                  state={{
                    rangeLabel: rangeLabel(pending.startLine, pending.endLine),
                    intent: 'note',
                    draft,
                    onDraftChange: setDraft,
                    onCancel: () => setPending(null),
                    onSave: save,
                  }}
                />
              </div>
            )}
          </div>
        )
      })}

      {pending?.at != null && (
        <SelectionQuestion
          left={pending.at.left}
          top={pending.at.top}
          rangeLabel={rangeLabel(pending.startLine, pending.endLine)}
          kicker="note"
          placeholder="What is wrong with this?"
          verb="leave it"
          onDismiss={() => {
            setPending(null)
            window.getSelection()?.removeAllRanges()
          }}
          onAsk={(body) => {
            onAnnotate(pending.startLine, pending.endLine, pending.quote, body)
            setPending(null)
            window.getSelection()?.removeAllRanges()
          }}
        />
      )}
    </div>
  )
}

/**
 * The source lines a DOM selection covers.
 *
 * The rendered markdown carries no source positions of its own, so each block's are written onto
 * its row and read back here. A selection that starts in one block and ends in another therefore
 * spans both, and one that lands outside any block — in the margin, or between rows — belongs to
 * no lines and is not a note.
 */
function sourceSpan(
  selection: Selection,
  container: HTMLElement,
): { startLine: number; endLine: number } | null {
  const ends = [selection.anchorNode, selection.focusNode]
    .map((node) => blockAround(node, container))
    .filter((el): el is HTMLElement => el !== null)
  if (ends.length === 0) return null

  const lines = ends.flatMap((el) => {
    const from = Number(el.dataset.startLine)
    const to = Number(el.dataset.endLine)
    return Number.isFinite(from) && Number.isFinite(to) ? [from, to] : []
  })
  if (lines.length === 0) return null
  return { startLine: Math.min(...lines), endLine: Math.max(...lines) }
}

function blockAround(node: Node | null, container: HTMLElement): HTMLElement | null {
  let at: Node | null = node
  while (at !== null && at !== container) {
    if (at instanceof HTMLElement && at.dataset.startLine !== undefined) return at
    at = at.parentNode
  }
  return null
}
