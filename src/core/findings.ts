import type { Chunk, Finding, RiskLevel } from './types.ts'

/**
 * Mapping one file's review back onto its chunks.
 *
 * The reviewer reads a whole file and reports findings by line; the board is organised by chunk.
 * A finding lands on the chunk whose lines it overlaps — the first one, if it overlaps several —
 * and anything that lands on none (unchanged code, or another file entirely) is kept as a
 * file-level finding rather than dropped.
 */

const ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 }

/** The worst severity among `findings`, or `none`. */
export function levelOf(findings: readonly Finding[]): RiskLevel {
  let worst: RiskLevel = 'none'
  for (const finding of findings) {
    if (ORDER[finding.severity] > ORDER[worst]) worst = finding.severity
  }
  return worst
}

function overlaps(chunk: Chunk, finding: Finding): boolean {
  const start = Math.min(finding.startLine, finding.endLine)
  const end = Math.max(finding.startLine, finding.endLine)
  return start <= chunk.endLine && end >= chunk.startLine
}

export type AssignedFindings = {
  /** By bare chunk key. Every chunk passed in has an entry, empty when nothing landed on it. */
  byChunk: Map<string, Finding[]>
  fileLevel: Finding[]
}

/**
 * `chunks` are one file's; `path` is that file.
 *
 * A finding in ANOTHER file — a caller this change broke — belongs to the change that broke it.
 * With a single change that is unambiguous, so it goes on that change's card; with several there
 * is no telling which, so it stays file-level.
 */
export function assignFindings(
  path: string,
  chunks: readonly Chunk[],
  findings: readonly Finding[],
): AssignedFindings {
  const byChunk = new Map<string, Finding[]>(chunks.map((chunk) => [chunk.key, []]))
  const fileLevel: Finding[] = []

  for (const finding of findings) {
    const home =
      finding.path === path
        ? chunks.find((chunk) => overlaps(chunk, finding))
        : chunks.length === 1
          ? chunks[0]
          : undefined
    if (home === undefined) fileLevel.push(finding)
    else byChunk.get(home.key)?.push(finding)
  }
  return { byChunk, fileLevel }
}
