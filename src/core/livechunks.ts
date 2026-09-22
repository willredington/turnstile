import { boardKey, unanalyzedReason } from './chunking.ts'
import type { Chunk, ChunkAnalysis, LiveChunk } from './types.ts'

/**
 * Deriving the chunk list the sidebar renders.
 *
 * Kept pure because the rules are all about *not losing* things: an in-flight analysis must
 * survive a recompute, a chunk whose content is unchanged must keep its identity, and a
 * chunk that has gone away must actually go away. Each of those is a one-line mistake that
 * shows up as a spinner that never stops.
 *
 * Root and bare-key discipline: `reconcile` turns a bare `Chunk` (keyed by content —
 * `core/chunking.ts`'s `chunkKey`, root-agnostic on purpose) into a `LiveChunk`, and
 * `toBoardKeys` is the one, final step that stamps every chunk's `.key` with
 * `boardKey(root, key)` right before per-root slices are concatenated into the session-wide
 * list — see its own doc comment.
 */

/**
 * Fold a freshly computed set of chunks together with what is already known.
 *
 * `analyzing` is what a review pass has claimed but not yet finished. Chunk keys hash content
 * and deliberately exclude line numbers, so a chunk that merely moved down the file keeps its
 * identity — and with it its analysis and its place in the list. A chunk being re-reviewed
 * (its file changed elsewhere) keeps its last analysis on screen while it is.
 */
export function reconcile(
  chunks: Chunk[],
  analyzing: ReadonlySet<string>,
  previous: LiveChunk[],
): LiveChunk[] {
  // Keyed by `contentKey`, not `key`: `previous` is the prior round's already-published
  // slice, whose `.key` has already been through `toBoardKeys` (composite) by the time it
  // gets here, while the fresh `chunk.key` below is still bare. `contentKey` is the one field
  // stable across that transformation.
  const before = new Map(previous.map((chunk) => [chunk.contentKey, chunk]))

  return chunks.map((chunk) => {
    const base = {
      key: chunk.key,
      contentKey: chunk.key,
      root: chunk.root,
      path: chunk.path,
      ...(chunk.previousPath === undefined ? {} : { previousPath: chunk.previousPath }),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      kind: chunk.kind,
    }

    if (!chunk.analyzable) {
      return {
        ...base,
        status: 'skipped' as const,
        analysis: null,
        reason: unanalyzedReason(chunk),
      }
    }

    // A recompute mid-review must neither knock a finished chunk back to pending nor show a
    // chunk being re-reviewed as settled.
    const analysis = before.get(chunk.key)?.analysis ?? null
    if (analyzing.has(chunk.key)) {
      return { ...base, status: 'analyzing' as const, analysis, reason: null }
    }
    if (analysis !== null) {
      return {
        ...base,
        status: 'ready' as const,
        analysis,
        reason: null,
      }
    }

    return { ...base, status: 'pending' as const, analysis: null, reason: null }
  })
}

/**
 * Stamp every chunk's `.key` with its cross-root live identity, replacing the bare content
 * key `reconcile` still uses internally.
 *
 * The one point where a per-root `LiveChunk[]` slice becomes safe to concatenate with every
 * other root's: two roots can produce the exact same bare `chunk.key` (identical relative
 * path, identical diff — two projects scaffolded from the same template), which would
 * silently conflate them in the combined session-wide list `markAnalyzing`/`markReady` key off.
 * Call this last, per root, right before concatenating.
 */
export function toBoardKeys(chunks: LiveChunk[]): LiveChunk[] {
  return chunks.map((chunk) => ({ ...chunk, key: boardKey(chunk.root, chunk.key) }))
}

/**
 * Mark one chunk as being reviewed, without disturbing the rest. A chunk that already has a
 * review keeps it on screen — its file changed elsewhere and is being read again.
 */
export function markAnalyzing(chunks: LiveChunk[], key: string): LiveChunk[] {
  return chunks.map((chunk) =>
    chunk.key === key && chunk.status !== 'skipped' ? { ...chunk, status: 'analyzing' } : chunk,
  )
}

/** Record a finished analysis. Unknown keys are ignored — the chunk may have gone away. */
export function markReady(chunks: LiveChunk[], key: string, analysis: ChunkAnalysis): LiveChunk[] {
  return chunks.map((chunk) =>
    chunk.key === key ? { ...chunk, status: 'ready', analysis, reason: null } : chunk,
  )
}

/**
 * Put chunks whose last review failed back to pending, saying why. `failed` is keyed by
 * bare content key. The failure is not final — the next pass tries again — so the chunk is
 * pending, not skipped; the reason is what tells a reader it is not just queued. Matched on
 * `contentKey`, so it works the same before and after `toBoardKeys`.
 */
export function markFailed(chunks: LiveChunk[], failed: ReadonlyMap<string, string>): LiveChunk[] {
  return chunks.map((chunk) => {
    const message = failed.get(chunk.contentKey)
    if (message === undefined || chunk.status === 'ready' || chunk.status === 'skipped') {
      return chunk
    }
    // A failed re-review leaves the last good review showing; there was nothing wrong with it.
    if (chunk.analysis !== null) return { ...chunk, status: 'ready' as const }
    return { ...chunk, status: 'pending' as const, reason: `Review failed: ${message}` }
  })
}

/**
 * Apply the risk bar's verdict to the chunk list.
 *
 * A hard skip, and it outranks whatever else the chunk knows about itself — including a
 * cached analysis from before the rule existed. The list is meant to answer "what does the
 * current policy say about this?", and a stale claim on a file the user has since told Turnstile
 * to leave alone answers a question nobody asked.
 *
 * Skipped is not hidden. The chunk keeps its place, its diff and its reason; what it loses
 * is the review, which is the point — attention is the scarce thing, not screen space.
 */
export function markSkipped(chunks: LiveChunk[], skips: ReadonlyMap<string, string>): LiveChunk[] {
  return chunks.map((chunk) => {
    const reason = skips.get(chunk.path)
    if (reason === undefined) return chunk
    return { ...chunk, status: 'skipped' as const, analysis: null, reason }
  })
}
