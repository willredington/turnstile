import { boardKey, unanalyzedReason } from './chunking.ts'
import { assignFindings, levelOf } from './findings.ts'
import type { Chunk, ChunkAnalysis, Finding, LiveChunk } from './types.ts'

/**
 * Deriving the chunk list the sidebar renders.
 *
 * Derived whole, every time, from two things: the board as it stands, and each file's current
 * review. There is nothing to carry across a recompute and so nothing to lose — a file's review
 * is either current (the file still hashes what it was reviewed at) or it is not, and that alone
 * decides whether its chunks show findings.
 *
 * Root and bare-key discipline: `liveChunks` works in bare content keys (`core/chunking.ts`'s
 * `chunkKey`, root-agnostic on purpose), and `toBoardKeys` is the one, final step that stamps
 * every chunk's `.key` with `boardKey(root, key)` right before per-root slices are concatenated
 * into the session-wide list — see its own doc comment.
 */

/** What is known about the review of one root's files, by path. */
export type ReviewView = {
  /** Whether a review is running on the file right now. */
  analyzing: (path: string) => boolean
  /** Why the last review of the file failed, if it did. Cleared by its next review. */
  failure: (path: string) => string | undefined
  /** A file's findings, when it has a current review — null when it has none. */
  findingsFor: (path: string) => readonly Finding[] | null
}

export type LiveBoard = {
  chunks: LiveChunk[]
  /** Findings that land on none of a file's chunks, per file that has any. */
  fileFindings: { path: string; findings: Finding[] }[]
}

/**
 * One root's chunks as the sidebar shows them.
 *
 * - `skipped` — never reviewed: too large or binary, or the risk bar's `skips` say so. A skip
 *   outranks everything else, a stored review included: the list answers "what does the policy
 *   say about this now?".
 * - `analyzing` — its file is being reviewed.
 * - `ready` — its file has a current review; the findings that land on it are its analysis.
 * - `pending` — its file has no current review: never reviewed, changed since, or its last
 *   review failed (then `reason` says why).
 */
export function liveChunks(
  chunks: readonly Chunk[],
  skips: ReadonlyMap<string, string>,
  view: ReviewView,
): LiveBoard {
  const byFile = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    if (!chunk.analyzable || skips.has(chunk.path)) continue
    const list = byFile.get(chunk.path) ?? []
    list.push(chunk)
    byFile.set(chunk.path, list)
  }

  const analyses = new Map<string, ChunkAnalysis>()
  const fileFindings: LiveBoard['fileFindings'] = []
  for (const [path, fileChunks] of byFile) {
    const findings = view.findingsFor(path)
    if (findings === null) continue
    const { byChunk, fileLevel } = assignFindings(path, fileChunks, findings)
    for (const chunk of fileChunks) {
      const own = byChunk.get(chunk.key) ?? []
      analyses.set(chunk.key, { riskLevel: levelOf(own), findings: own })
    }
    if (fileLevel.length > 0) fileFindings.push({ path, findings: fileLevel })
  }

  const live = chunks.map((chunk): LiveChunk => {
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
      return { ...base, status: 'skipped', analysis: null, reason: unanalyzedReason(chunk) }
    }
    const skip = skips.get(chunk.path)
    if (skip !== undefined) return { ...base, status: 'skipped', analysis: null, reason: skip }

    const analysis = analyses.get(chunk.key) ?? null
    if (view.analyzing(chunk.path)) {
      return { ...base, status: 'analyzing', analysis, reason: null }
    }
    if (analysis !== null) return { ...base, status: 'ready', analysis, reason: null }
    const failure = view.failure(chunk.path)
    return {
      ...base,
      status: 'pending',
      analysis: null,
      reason: failure === undefined ? null : `Review failed: ${failure}`,
    }
  })

  return { chunks: live, fileFindings }
}

/**
 * Stamp every chunk's `.key` with its cross-root live identity, replacing the bare content
 * key `liveChunks` still uses internally.
 *
 * The one point where a per-root `LiveChunk[]` slice becomes safe to concatenate with every
 * other root's: two roots can produce the exact same bare `chunk.key` (identical relative
 * path, identical diff — two projects scaffolded from the same template), which would
 * silently conflate them in the combined session-wide list the UI keys chunks by.
 * Call this last, per root, right before concatenating.
 */
export function toBoardKeys(chunks: LiveChunk[]): LiveChunk[] {
  return chunks.map((chunk) => ({ ...chunk, key: boardKey(chunk.root, chunk.key) }))
}
