import type { Finding, Severity } from './types.ts'

/**
 * What the reviewer submits, checked and sorted into the files it reviewed.
 *
 * A finding may sit anywhere — a caller the change broke is a finding in the caller — but the
 * board reviews files, so every finding has to belong to one of the files under review: its own
 * `path` when that is one of them, or else the `cause` it names. What a schema cannot say is
 * checked here, all at once, and worded for the reviewer to read and correct, since the submit
 * tool hands the error back mid-run.
 */

export type SubmittedFinding = {
  path: string
  startLine: number
  endLine: number
  severity: Severity
  title: string
  message: string
  /** The file under review whose change causes this one, when `path` is not one of them. */
  cause?: string | undefined
}

/**
 * `reviewed` are the paths under review, relative to the repository root, as are the
 * submission's. Every reviewed path has an entry in the result, empty when nothing was found.
 */
export function groupFindings(
  reviewed: readonly string[],
  submitted: readonly SubmittedFinding[],
): { byFile: Map<string, Finding[]> } | { error: string } {
  const underReview = new Set(reviewed)
  const byFile = new Map<string, Finding[]>(reviewed.map((path) => [path, []]))
  const problems: string[] = []

  submitted.forEach((submission, index) => {
    const { cause, ...finding } = submission
    const where = `finding ${index + 1} (${finding.path}:${finding.startLine})`

    if (finding.path.startsWith('/') || finding.path.split('/').includes('..')) {
      problems.push(`${where}: path must be relative to the repository root`)
      return
    }
    if (finding.startLine < 1 || finding.endLine < finding.startLine) {
      problems.push(`${where}: needs 1 <= startLine <= endLine`)
      return
    }
    if (finding.title.trim() === '' || finding.message.trim() === '') {
      problems.push(`${where}: needs a title and a message`)
      return
    }

    const home = underReview.has(finding.path) ? finding.path : cause
    if (home === undefined) {
      problems.push(
        `${where}: ${finding.path} is not under review, so name the file under review whose ` +
          'change causes it as cause',
      )
      return
    }
    if (!underReview.has(home)) {
      problems.push(`${where}: cause ${home} is not one of the files under review`)
      return
    }
    byFile
      .get(home)
      ?.push({ ...finding, title: finding.title.trim(), message: finding.message.trim() })
  })

  if (problems.length > 0) return { error: `Not accepted — ${problems.join('; ')}.` }
  return { byFile }
}
