import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, type WidgetType } from '@codemirror/view'
import type {
  DocumentPlan,
  PlanBand,
  PlanFold,
  PlanRemoval,
} from '../../../../core/documentPlan.ts'

/** The block-level UI the document hangs off its lines. Injected so the placement logic can be
 *  tested without a DOM, and so the React side owns what a band or a card actually looks like. */
export type BlockWidgets = {
  band: (band: PlanBand) => WidgetType
  removal: (removal: PlanRemoval) => WidgetType
  fold: (fold: PlanFold) => WidgetType
}

const ADD_LINE = Decoration.line({ class: 'ts-add' })
const ASK_LINE = Decoration.line({ class: 'ts-asked' })

/**
 * The lines a question is about, marked for as long as the question is on screen.
 *
 * Asking used to lose the thing it was about: the question box takes the cursor, which means
 * letting go of the editor, and letting go of the editor takes the browser's own highlight with
 * it. The lines you picked stopped being pointed at the moment you started typing about them.
 *
 * Whole lines, not the characters that were dragged. A question is anchored to lines, its card
 * says "lines 119-133", and those whole lines are what gets read to answer it — tinting less
 * would show the reader something other than what they asked about.
 */
export function askedLines(
  state: EditorState,
  span: { startLine: number; endLine: number },
): Range<Decoration>[] {
  const total = state.doc.lines
  // A question whose lines the file no longer has — it was asked, then the file shrank under
  // it — marks nothing rather than dragging its tint onto whatever ended up last.
  if (span.startLine > total || span.endLine < span.startLine) return []

  const first = Math.max(1, span.startLine)
  const last = Math.min(total, span.endLine)
  const ranges: Range<Decoration>[] = []
  for (let line = first; line <= last; line += 1) {
    ranges.push(ASK_LINE.range(state.doc.line(line).from))
  }
  return ranges
}

/**
 * Turn a `DocumentPlan` into the decorations CodeMirror draws.
 *
 * The plan is expressed in line numbers, which is what the domain thinks in; this is the only
 * place that converts those into document offsets. Built with `Decoration.set(…, true)` rather
 * than a `RangeSetBuilder` because bands, removals, accents and folds interleave on the same
 * lines and the builder demands they arrive already sorted — letting CodeMirror sort them
 * removes a whole class of "decorations must be sorted" crashes that depend on which change
 * shapes a file happens to contain.
 */
/**
 * A card above the whole document, for the findings that landed on none of its changes.
 *
 * `side: -3` puts it above a band, the only other block that can sit on offset 0 — a band
 * announces one hunk, and these findings are about the file that contains it.
 *
 * Kept out of `decorationsFor` because it does not come from the plan: the plan describes the
 * diff, and a file-level finding is precisely one the diff has no place for. It rides inside
 * the document rather than above the editor so that it scrolls with the file.
 */
export function headerDecoration(widget: WidgetType): Range<Decoration> {
  return Decoration.widget({ widget, block: true, side: -3 }).range(0)
}

export function decorationsFor(
  state: EditorState,
  plan: DocumentPlan,
  widgets: BlockWidgets,
): DecorationSet {
  const total = state.doc.lines
  const clamp = (line: number): number => Math.max(1, Math.min(total, line))
  const startOf = (line: number): number => state.doc.line(clamp(line)).from

  const ranges: Range<Decoration>[] = []

  for (const band of plan.bands) {
    const at = startOf(band.line)
    // `side: -2` keeps a band above the removals that sit on the same line.
    ranges.push(Decoration.widget({ widget: widgets.band(band), block: true, side: -2 }).range(at))
  }

  for (const removal of plan.removals) {
    // A run that ends a hunk anchors one past the last line, which is not a line at all.
    const at = removal.line > total ? state.doc.length : startOf(removal.line)
    ranges.push(
      Decoration.widget({ widget: widgets.removal(removal), block: true, side: -1 }).range(at),
    )
  }

  // Only what the change actually rewrote is tinted. An unchanged line inside a change's
  // range is still ordinary context to read — the band above it is what says the change
  // reaches this far — and tinting them all would put a decoration on every line of a large
  // change to no visible end.
  for (const accent of plan.accents) {
    if (accent.kind !== 'add') continue
    ranges.push(ADD_LINE.range(startOf(accent.line)))
  }

  for (const fold of plan.folds) {
    const from = startOf(fold.startLine)
    const to = state.doc.line(clamp(fold.endLine)).to
    if (to <= from) continue
    ranges.push(Decoration.replace({ widget: widgets.fold(fold), block: true }).range(from, to))
  }

  return Decoration.set(ranges, true)
}

/** Hand the editor a new set of decorations. */
export const setDecorations = StateEffect.define<DecorationSet>()

/**
 * Where the document's decorations live.
 *
 * A field rather than a plain `EditorView.decorations.of(...)` so CodeMirror maps them through
 * the reader's own edits: type a line above a finding and the finding moves with its code
 * instead of staying at the offset it was computed for.
 */
export const decorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(current, transaction) {
    let next = current.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setDecorations)) next = effect.value
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})
