import type { RiskBarConfig } from '../core/config.ts'
import type { ReviewedFile, Reviewer, RootHandle, RootRegistry } from '../core/ports.ts'
import { skipReasons } from '../core/riskbar.ts'
import type { ReviewerUpdate, StoredReview } from '../core/types.ts'
import { captureBoardFor, chunksOf, fileHashes } from './board.ts'

/**
 * The review: every changed file with no current review, read by one reviewer in one run.
 *
 * Run at the end of a turn that changed something, and when the human asks (`reviewNow`). Never
 * mid-turn: a review of work the agent is still in the middle of is a review of something that
 * is about to change. A file's review is current while the file still hashes what it was
 * reviewed at (`StoredReview.fileHash`), so a file is picked up here exactly when it has never
 * been reviewed or has changed since — whoever changed it.
 *
 * Strictly best-effort. Every failure path here costs a missing review and nothing else, so
 * nothing in this file is allowed to throw into the turn.
 */

/** Past this, the diff the reviewer is handed is cut short — it can still read every file. */
export const MAX_DIFF_CHARS = 200_000

export type ReviewDeps = {
  roots: RootRegistry
  reviewer: Reviewer
  /** Which files are not worth reviewing — lockfiles, generated code, docs and the like. */
  riskBar: Pick<RiskBarConfig, 'alwaysReview' | 'neverReview' | 'specPaths'>
  /** The hash a file was last reviewed at, if it has been. */
  reviewedHash: (root: string, path: string) => string | undefined
  /** A review started, over these files. */
  onReviewing?: (root: string, paths: string[]) => void
  /** The reviewer moved on a step, or made another call. */
  onProgress?: (root: string, update: ReviewerUpdate) => void
  /** The review finished: one entry per file it covered. */
  onReviewed?: (root: string, reviews: StoredReview[]) => void
  /** The review failed. Its files stay unreviewed until the next one. */
  onFailed?: (root: string, paths: string[], message: string) => void
}

export type ReviewResult = {
  /** Files reviewed. */
  reviewed: number
  skipped: string | null
}

const IDLE: ReviewResult = { reviewed: 0, skipped: null }

/** One root's share of the pass. */
async function reviewRoot(handle: RootHandle, deps: ReviewDeps): Promise<ReviewResult> {
  const { base, next, deltas } = await captureBoardFor(handle)
  if (deltas.length === 0) return IDLE

  const chunks = await chunksOf(handle.root, handle.snapshots, base, next, deltas)
  const skips = skipReasons(deltas, deps.riskBar)

  const reviewable = new Set(
    chunks.filter((chunk) => chunk.analyzable && !skips.has(chunk.path)).map((chunk) => chunk.path),
  )

  // Hashed as the files stand NOW, before the review runs: a file changed while it is being
  // reviewed keeps its old hash on the review, and so reads stale rather than reviewed.
  const candidates = deltas.filter((delta) => reviewable.has(delta.path))
  const hashes = await fileHashes(handle.snapshots, next, candidates)
  const stale = candidates.flatMap((delta) => {
    const hash = hashes.get(delta.path) ?? ''
    return deps.reviewedHash(handle.root, delta.path) === hash ? [] : [{ delta, hash }]
  })
  if (stale.length === 0) return IDLE

  const paths = stale.map(({ delta }) => delta.path)
  deps.onReviewing?.(handle.root, paths)

  try {
    const files: ReviewedFile[] = []
    const patches: string[] = []
    for (const { delta } of stale) {
      const kind = chunks.find((chunk) => chunk.path === delta.path)?.kind ?? 'modified'
      files.push({
        path: delta.path,
        kind,
        ...(delta.previousPath === undefined ? {} : { previousPath: delta.previousPath }),
      })
      patches.push(await handle.snapshots.patch(base, next, delta.path, delta.previousPath))
    }

    const byFile = await deps.reviewer.review(
      { root: handle.root, files, diff: capped(patches.join('\n')) },
      (update) => deps.onProgress?.(handle.root, update),
    )

    const reviewedAt = new Date().toISOString()
    const reviews = stale.map(({ delta, hash }): StoredReview => {
      const findings = byFile.get(delta.path) ?? []
      return { root: handle.root, path: delta.path, fileHash: hash, findings, reviewedAt }
    })
    deps.onReviewed?.(handle.root, reviews)
    return { reviewed: reviews.length, skipped: null }
  } catch (error) {
    deps.onFailed?.(handle.root, paths, error instanceof Error ? error.message : String(error))
    return IDLE
  }
}

/** The diff as the reviewer gets it: whole, or cut short and saying so. */
function capped(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return (
    `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[The diff is cut short here, at ${MAX_DIFF_CHARS} ` +
    'characters. Read the files under review for the rest.]'
  )
}

/**
 * Runs `reviewRoot` across every known root and combines the results.
 *
 * Each root's pass is independently best-effort: one root failing (its directory vanished
 * mid-session, a git call errored) costs that root's review, never every other root's.
 */
export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  const failures: string[] = []
  let reviewed = 0
  for (const handle of deps.roots.knownRoots()) {
    try {
      const result = await reviewRoot(handle, deps)
      reviewed += result.reviewed
    } catch (error) {
      failures.push(`${handle.root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { reviewed, skipped: failures.length > 0 ? failures.join('; ') : null }
}
