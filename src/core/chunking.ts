import { createHash } from 'node:crypto'
import { changedLineCount, gapBetween, hunkRange } from './patch.ts'
import type { Chunk, ParsedPatch, PatchHunk } from './types.ts'

/**
 * Turning a file's diff into reviewable units.
 *
 * Hunks are the diff's own boundaries, so they are the natural grain — but raw hunks are
 * both too fragmented (a rename touching six adjacent lines becomes six adjudications)
 * and occasionally too coarse (a 400-line rewrite in one hunk). Coalesce, then split.
 */

/** Hunks closer than this many unchanged lines are almost always one logical change. */
export const COALESCE_GAP = 6

/** Changed-line ceiling for a single chunk before it is split. */
export const MAX_CHUNK_LINES = 120

/**
 * Changed-line ceiling past which a chunk is not sent to a model.
 *
 * It is still rendered in full and still gates — the budget governs model calls, never
 * what the human sees.
 */
export const MAX_ANALYSIS_LINES = 400

/**
 * Stable content identity for a chunk.
 *
 * Line numbers are deliberately excluded. Hashing the `@@ -412,9 +418,11 @@` header would
 * mean that inserting ten lines at the top of a file shifts every hunk below it and misses
 * the entire cache — the single most likely way for this scheme to quietly stop working.
 * Hashing the body means relocated code keeps its identity.
 *
 * `occurrence` disambiguates genuinely identical chunks within one file: the same three-line
 * change made in two places is two decisions, not one. It counts copies OF THIS BODY, not
 * position in the file — those are different numbers, and the difference matters now that a
 * key is what carries an approval. Position would mean inserting an unrelated change above a
 * chunk gives it a new identity, and every approval below the insertion point would come
 * back unreviewed.
 */
export function chunkKey(path: string, hunks: PatchHunk[], occurrence: number): string {
  return createHash('sha256')
    .update(`${path}\0${chunkBody(hunks)}\0${occurrence}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Cross-root live identity for one chunk, inside one combined multi-root review batch.
 *
 * Never used for storage (`ReviewLedger`/`AnalysisCache` all keep using the
 * bare `chunkKey()` — see those ports' doc comments). This exists only because `chunkKey()`
 * hashes path+content, not root: two sibling roots with an identical relative path and an
 * identical diff (two projects scaffolded from the same template) produce the same
 * `chunkKey()` output, which would collide inside one turn's combined `Chunk[]`/review
 * payload/`verdicts` map if the bare key were used as the wire-facing identity there.
 */
export function boardKey(root: string, key: string): string {
  return createHash('sha256').update(`${root}\0${key}`).digest('hex').slice(0, 32)
}

/** The changed and context lines, with their markers — everything but where they sit. */
function chunkBody(hunks: PatchHunk[]): string {
  return hunks
    .flatMap((hunk) => hunk.lines.map((line) => `${symbolFor(line.kind)}${line.text}`))
    .join('\n')
}

function symbolFor(kind: 'add' | 'remove' | 'context'): string {
  if (kind === 'add') return '+'
  if (kind === 'remove') return '-'
  return ' '
}

/** Group hunks into runs separated by more than COALESCE_GAP unchanged lines. */
function coalesce(hunks: PatchHunk[]): PatchHunk[][] {
  const groups: PatchHunk[][] = []

  for (const hunk of hunks) {
    const current = groups[groups.length - 1]
    const previous = current?.[current.length - 1]

    if (
      current !== undefined &&
      previous !== undefined &&
      gapBetween(previous, hunk) < COALESCE_GAP
    ) {
      current.push(hunk)
    } else {
      groups.push([hunk])
    }
  }

  return groups
}

/**
 * Break an oversized group at hunk boundaries.
 *
 * Splitting mid-hunk would hand the model half a change, so a single hunk over the budget
 * is left whole and simply becomes a large chunk — which the analysis budget then handles
 * by declining to analyze it rather than by analyzing a fragment.
 */
function split(group: PatchHunk[]): PatchHunk[][] {
  if (changedLineCount(group) <= MAX_CHUNK_LINES) return [group]

  const parts: PatchHunk[][] = []
  let current: PatchHunk[] = []

  for (const hunk of group) {
    if (current.length > 0 && changedLineCount([...current, hunk]) > MAX_CHUNK_LINES) {
      parts.push(current)
      current = []
    }
    current.push(hunk)
  }

  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * A file's diff as reviewable chunks.
 *
 * A whole-file create or delete is always one chunk, never split: its content is
 * definitionally "all of it", and a 55-line deletion is one decision rather than five.
 */
export function chunkPatch(parsed: ParsedPatch, root: string): Chunk[] {
  const wholeFile = parsed.kind === 'created' || parsed.kind === 'deleted'

  if (parsed.hunks.length === 0) {
    // Binary files, and mode-only or pure-rename changes, carry no hunks but are still
    // changes the human must see and decide on.
    return [
      buildChunk(parsed, root, [], 0, {
        wholeFile,
        startLine: 0,
        endLine: 0,
      }),
    ]
  }

  const groups = wholeFile ? [parsed.hunks] : coalesce(parsed.hunks).flatMap(split)

  // Counted per body rather than per group, so a chunk's identity does not depend on how
  // many other chunks happen to precede it in the file.
  const seen = new Map<string, number>()

  return groups.map((group) => {
    const first = group[0] as PatchHunk
    const last = group[group.length - 1] as PatchHunk
    const body = chunkBody(group)
    const occurrence = seen.get(body) ?? 0
    seen.set(body, occurrence + 1)

    return buildChunk(parsed, root, group, occurrence, {
      wholeFile,
      startLine: hunkRange(first).startLine,
      endLine: hunkRange(last).endLine,
    })
  })
}

function buildChunk(
  parsed: ParsedPatch,
  root: string,
  hunks: PatchHunk[],
  occurrence: number,
  extra: { wholeFile: boolean; startLine: number; endLine: number },
): Chunk {
  const added = hunks.reduce(
    (n, hunk) => n + hunk.lines.filter((line) => line.kind === 'add').length,
    0,
  )
  const removed = hunks.reduce(
    (n, hunk) => n + hunk.lines.filter((line) => line.kind === 'remove').length,
    0,
  )

  return {
    key: chunkKey(parsed.path, hunks, occurrence),
    root,
    path: parsed.path,
    ...(parsed.previousPath === undefined ? {} : { previousPath: parsed.previousPath }),
    kind: parsed.kind,
    startLine: extra.startLine,
    endLine: extra.endLine,
    addedCount: added,
    removedCount: removed,
    hunks,
    // Binary content cannot be reasoned about from a patch, so it is never analyzed —
    // but it is always shown and always gates.
    analyzable: parsed.kind !== 'binary' && changedLineCount(hunks) <= MAX_ANALYSIS_LINES,
    wholeFile: extra.wholeFile,
  }
}

/** Why a chunk was not analyzed, for the label the human sees. */
export function unanalyzedReason(chunk: Chunk): string {
  if (chunk.kind === 'binary') return 'binary file — not analyzed'
  return `${chunk.addedCount + chunk.removedCount} changed lines — too large to analyze`
}
