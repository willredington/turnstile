import { createHash } from 'node:crypto'
import type { RiskBarConfig } from '../core/config.ts'
import type {
  AnalysisCache,
  RepoReader,
  Reviewer,
  RootHandle,
  RootRegistry,
  RuleSource,
  Telemetry,
} from '../core/ports.ts'
import { skipReasons } from '../core/riskbar.ts'
import { type ContextDoc, contextFor, type Rule, rulesFor } from '../core/rules.ts'
import { noopTelemetry } from '../core/telemetry.ts'
import type { Chunk, Finding } from '../core/types.ts'
import { type Board, captureBoardFor, chunksOf } from './board.ts'

/**
 * The review: every changed file, checked against the repository's rules, while the agent is
 * still working.
 *
 * Run after every edit (and every Bash call), so a file's findings fill in on the board shortly
 * after it changes rather than all at once when the turn ends. One review per FILE, not per
 * chunk: the reviewer needs the whole file — and the rest of the repository, through `reader` —
 * to tell whether a change keeps each rule that governs it. Results are cached by `reviewKey` —
 * the file's content, its changes and the rules and context it was reviewed against — so a file
 * nobody touched again, under rules nobody edited, is never reviewed twice. A file no rule
 * governs is not sent to the reviewer at all.
 *
 * Strictly best-effort. Every failure path here costs a missing review and nothing else, so
 * nothing in this file is allowed to throw into the turn.
 */

/** Bump when the prompt or the shape of what is reviewed changes, so old reviews stop matching. */
const REVIEW_VERSION = '3'

export type ReviewDeps = {
  roots: RootRegistry
  reviewer: Reviewer
  cache: AnalysisCache
  rules: RuleSource
  /** The rest of the repository, read-only, for the reviewer's tools. */
  reader: RepoReader
  /** Which files are not worth reviewing — lockfiles, generated code, docs and the like. */
  riskBar: Pick<RiskBarConfig, 'alwaysReview' | 'neverReview' | 'specPaths'>
  /** Files reviewed at once. */
  concurrency: number
  /** Where the pass reports its own timings and counts. Silent by default. */
  telemetry?: Telemetry
  /** The board as it stands, before anything is reviewed — so the list shows at once. */
  onChunks?: (root: string, chunks: Chunk[], skips: ReadonlyMap<string, string>) => void
  /** A file's review started. `chunks` are the ones it covers. */
  onReviewing?: (root: string, path: string, chunks: Chunk[]) => void
  /** A file's review finished, fresh or from the cache. */
  onReviewed?: (root: string, path: string, chunks: Chunk[], findings: Finding[]) => void
  /** The model call for a file failed. Its chunks stay unreviewed and are tried again next pass. */
  onFailed?: (root: string, path: string, chunks: Chunk[], message: string) => void
}

export type ReviewResult = {
  reviewed: number
  /** Already cached from an earlier pass. */
  hits: number
  skipped: string | null
}

const IDLE: ReviewResult = { reviewed: 0, hits: 0, skipped: null }

/** A file's review identity: everything the review was a function of. */
function reviewKey(
  path: string,
  chunks: readonly Chunk[],
  content: string | null,
  rules: readonly Rule[],
  context: readonly ContextDoc[],
): string {
  const hash = createHash('sha256')
  const part = (value: string) => hash.update(value).update('\0')
  part(REVIEW_VERSION)
  part(path)
  part(chunks[0]?.previousPath ?? '')
  for (const key of chunks.map((chunk) => chunk.key).sort()) part(key)
  part(content ?? '\0deleted')
  // Every field, since every field is either shown to the reviewer or part of the finding.
  for (const rule of rules) {
    part(rule.name)
    part(rule.description)
    part(rule.globs.join(','))
    part(rule.severity ?? '')
    part(rule.rule)
    part(rule.violates ?? '')
    part(rule.complies ?? '')
  }
  for (const doc of context) {
    part(doc.path)
    part(doc.body)
  }
  return hash.digest('hex').slice(0, 32)
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

/** One root's share of the pass. */
async function reviewRoot(
  handle: RootHandle,
  board: Board,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const { cache } = deps
  const telemetry = deps.telemetry ?? noopTelemetry
  const { base, next, deltas } = board

  if (deltas.length === 0) return IDLE

  const chunks = await chunksOf(handle.root, handle.snapshots, base, next, deltas)

  // Announced before anything is reviewed, so the list exists the moment an edit lands, with
  // the skipped files already saying why rather than queueing for work that will never happen.
  const skips = skipReasons(deltas, deps.riskBar)
  deps.onChunks?.(handle.root, chunks, skips)
  // What the review never looks at is the blind spot, so it is counted alongside what it does.
  if (skips.size > 0) {
    telemetry.count('turnstile.review.files', { outcome: 'skipped' }, skips.size)
  }

  const byFile = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    if (!chunk.analyzable || skips.has(chunk.path)) continue
    const list = byFile.get(chunk.path) ?? []
    list.push(chunk)
    byFile.set(chunk.path, list)
  }
  if (byFile.size === 0) return IDLE

  const { rules, context } = await deps.rules.load(handle.root)

  let reviewed = 0
  let hits = 0
  await pool([...byFile], deps.concurrency, async ([path, fileChunks]) => {
    const fileRules = rulesFor(path, rules)
    // Nothing to check it against: a clean review, with no model call to make one.
    if (fileRules.length === 0) {
      telemetry.count('turnstile.review.files', { outcome: 'unruled' })
      deps.onReviewed?.(handle.root, path, fileChunks, [])
      return
    }
    const kind = fileChunks[0]?.kind ?? 'modified'
    const content = kind === 'deleted' ? null : await handle.snapshots.contents(next, path)
    const fileContext = contextFor(path, context)
    const key = reviewKey(path, fileChunks, content, fileRules, fileContext)

    const hit = await cache.get(key)
    if (hit !== null) {
      hits += 1
      // Counted apart from a fresh review, and with no span: a hit is the absence of the work a
      // span would be timing, and conflating the two would make the review look faster the more
      // of it was skipped.
      telemetry.count('turnstile.review.files', { outcome: 'cached' })
      deps.onReviewed?.(handle.root, path, fileChunks, hit.findings)
      return
    }

    // Another pass from a rapid burst of edits may already be on this file.
    if (!(await cache.claim(key))) return
    deps.onReviewing?.(handle.root, path, fileChunks)
    try {
      const previousPath = fileChunks[0]?.previousPath
      // The span covers the model call alone, so its duration is the thing that actually costs
      // time and its failure is the model's, not the cache write's or a callback's.
      const findings = await telemetry.span(
        'turnstile.review.file',
        { 'turnstile.path': path, 'turnstile.kind': kind },
        () =>
          deps.reviewer.reviewFile({
            root: handle.root,
            path,
            ...(previousPath === undefined ? {} : { previousPath }),
            kind,
            content,
            chunks: fileChunks,
            rules: fileRules,
            context: fileContext,
            reader: deps.reader,
          }),
      )
      await cache.put(key, { findings })
      for (const finding of findings) {
        telemetry.count('turnstile.findings', { severity: finding.severity })
      }
      telemetry.count('turnstile.review.files', { outcome: 'reviewed' })
      deps.onReviewed?.(handle.root, path, fileChunks, findings)
      reviewed += 1
    } catch (error) {
      // Left unreviewed; the next pass tries again. Reported, so the file does not sit on
      // "reviewing" forever looking like a review that never ran.
      telemetry.count('turnstile.review.files', { outcome: 'failed' })
      deps.onFailed?.(
        handle.root,
        path,
        fileChunks,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      await cache.release(key)
    }
  })

  return { reviewed, hits, skipped: null }
}

/**
 * Runs `reviewRoot` across every known root and combines the results.
 *
 * Each root's pass is independently best-effort: one root failing (its directory vanished
 * mid-session, a git call errored) costs that root's reviews, never every other root's.
 */
export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  // The pass is the parent span every per-file review hangs off, which is what makes a slow
  // turn readable: one bar with the files that made it slow nested inside it. Nothing in here
  // opens an agent `query()`, so this span never becomes the parent of an agent's whole session
  // — see `adapters/otel/telemetry.ts` on why that matters.
  return (deps.telemetry ?? noopTelemetry).span('turnstile.review.run', {}, async () => {
    try {
      const handles = deps.roots.knownRoots()
      const failures: string[] = []
      let reviewed = 0
      let hits = 0

      for (const handle of handles) {
        try {
          const board = await captureBoardFor(handle)
          const result = await reviewRoot(handle, board, deps)
          reviewed += result.reviewed
          hits += result.hits
          if (result.skipped !== null) failures.push(`${handle.root}: ${result.skipped}`)
        } catch (error) {
          failures.push(`${handle.root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      return { reviewed, hits, skipped: failures.length > 0 ? failures.join('; ') : null }
    } catch (error) {
      return { ...IDLE, skipped: error instanceof Error ? error.message : String(error) }
    }
  })
}
