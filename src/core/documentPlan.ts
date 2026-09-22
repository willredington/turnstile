import { hunkRange } from './patch.ts'
import type { ParsedPatch } from './types.ts'

/** Runs of unchanged lines longer than this, belonging to no change, collapse behind a click. */
const DOCUMENT_FOLD_THRESHOLD = 8

/**
 * Unchanged lines kept visible on each side of a fold.
 *
 * A margin is kept at the document's own start and end too, not just where a fold abuts a
 * change. The top of a file is not filler — it is the imports and the module's opening
 * comment, which is orientation a reader wants before they read anything else, and a file that
 * opens on "⋯ 96 unchanged lines" has hidden the one run of context nobody needed to ask for.
 */
const DOCUMENT_FOLD_MARGIN = 3

/** A change, as the document needs to know it: an identity and the lines it claims. */
export type DocumentRegion = {
  key: string
  /** New-side line numbers, inclusive — `Chunk`'s own `startLine`/`endLine`. */
  startLine: number
  endLine: number
}

/** The announcement above a change: which one, where it starts, how much of it there is. */
export type PlanBand = {
  chunkKey: string
  /** New-side line the band sits above. */
  line: number
  startLine: number
  endLine: number
  /** Lines the change contributed to the file as it now stands — removals excluded. */
  lineCount: number
}

/** A line that carries a change's accent, and what the change did to it. */
type PlanAccent = {
  /** New-side line number. */
  line: number
  kind: 'add' | 'context'
  chunkKey: string
}

/**
 * A run of removed lines, kept where it was.
 *
 * A removal has no new-side number of its own, so it cannot be placed by line range the way
 * everything else is: it sits above the line that replaced it, and belongs to whichever change
 * owns the hunk it came out of.
 */
export type PlanRemoval = {
  /** The new-side line this run sits above. One past the last line for a run that ends a hunk. */
  line: number
  chunkKey: string | null
  texts: string[]
  /** Old-side line numbers, one per text — what a note left on a removed line is anchored to. */
  oldLines: number[]
}

/** A run of unchanged lines, belonging to no change, that may collapse behind a click. */
export type PlanFold = {
  startLine: number
  endLine: number
  lineCount: number
}

export type DocumentPlan = {
  bands: PlanBand[]
  accents: PlanAccent[]
  removals: PlanRemoval[]
  folds: PlanFold[]
}

/**
 * Split file text into lines the way a diff counts them: a trailing newline ends the last
 * line rather than starting an empty one.
 */
function lineCountOf(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export function buildDocumentPlan(
  fileText: string,
  patch: ParsedPatch,
  regions: readonly DocumentRegion[],
  threshold: number = DOCUMENT_FOLD_THRESHOLD,
  margin: number = DOCUMENT_FOLD_MARGIN,
): DocumentPlan {
  const total = lineCountOf(fileText)

  const added = new Set<number>()
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newLine !== null) added.add(line.newLine)
    }
  }

  const removals: PlanRemoval[] = []
  for (const hunk of patch.hunks) {
    const range = hunkRange(hunk)
    const owner =
      regions.find(
        (region) => range.startLine <= region.endLine && range.endLine >= region.startLine,
      )?.key ?? null

    let pending: string[] = []
    let pendingOld: number[] = []
    let lastNew = hunk.newStart - 1
    for (const line of hunk.lines) {
      if (line.kind === 'remove') {
        pending.push(line.text)
        if (line.oldLine !== null) pendingOld.push(line.oldLine)
        continue
      }
      if (line.newLine === null) continue
      if (pending.length > 0) {
        removals.push({
          line: line.newLine,
          chunkKey: owner,
          texts: pending,
          oldLines: pendingOld,
        })
        pending = []
        pendingOld = []
      }
      lastNew = line.newLine
    }
    // A run that ends a hunk has no following new-side line to sit above, so it goes after
    // the last line the hunk touched.
    if (pending.length > 0) {
      removals.push({
        line: lastNew + 1,
        chunkKey: owner,
        texts: pending,
        oldLines: pendingOld,
      })
    }
  }

  const bands: PlanBand[] = []
  const accents: PlanAccent[] = []
  for (const region of regions) {
    const start = Math.max(1, region.startLine)
    const end = Math.min(total, region.endLine)
    if (end < start) continue
    bands.push({
      chunkKey: region.key,
      line: start,
      startLine: start,
      endLine: end,
      lineCount: end - start + 1,
    })
    // Every line in a change's range carries its accent, not just the ones it rewrote: an
    // unchanged line between two of its hunks is the context the change is read in.
    for (let line = start; line <= end; line += 1) {
      accents.push({ line, kind: added.has(line) ? 'add' : 'context', chunkKey: region.key })
    }
  }
  bands.sort((a, b) => a.line - b.line)
  accents.sort((a, b) => a.line - b.line)

  // A changed line never folds, and neither does an unchanged line inside a change's range —
  // that line is the context the change is being read in.
  const held = new Set<number>(accents.map((accent) => accent.line))
  for (const line of added) held.add(line)

  const folds: PlanFold[] = []
  let line = 1
  while (line <= total) {
    if (held.has(line)) {
      line += 1
      continue
    }
    const start = line
    while (line <= total && !held.has(line)) line += 1
    const run = line - start
    if (run > threshold) {
      const foldStart = start + margin
      const foldEnd = line - 1 - margin
      folds.push({ startLine: foldStart, endLine: foldEnd, lineCount: foldEnd - foldStart + 1 })
    }
  }

  return { bands, accents, removals, folds }
}
