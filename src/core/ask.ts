import { numbered } from './numbering.ts'

/**
 * What the asker is shown: one question about one file, with enough of the file around it to
 * answer, and whatever was already asked in this thread.
 *
 * Pure, and bounded on purpose. A selection inside a 5,000-line file must not send the file —
 * the asker can `read_file` for the rest, and paying for the whole file on every follow-up is
 * how a cheap question stops being cheap.
 */

/** The lines a question is about, or null for the whole file. */
export type AskAnchor = { startLine: number; endLine: number } | null

/** One exchange already in this thread. */
export type AskTurn = { question: string; answer: string }

export type AskPayloadInput = {
  path: string
  /** The file as it stands on disk. */
  fileText: string
  anchor: AskAnchor
  /** Earlier exchanges in this thread, oldest first. Empty for a first question. */
  history: AskTurn[]
  question: string
}

/** Lines of file shown at most, before the region around the selection is all that is sent. */
const MAX_FILE_LINES = 1500
/** Lines of surrounding file kept on either side of the selection. */
const WINDOW = 60

/**
 * The span of the file to show: the selection whole, with as much context around it as fits.
 *
 * The selection is never trimmed — a question about lines 40–1900 is a question about all of
 * them, and eliding the middle would have the asker answer about code it was not shown. The
 * context shrinks instead, to nothing if it has to.
 */
function spanFor(anchor: AskAnchor, total: number): { from: number; to: number } {
  if (anchor === null) return { from: 1, to: Math.min(total, MAX_FILE_LINES) }

  const start = Math.max(1, Math.min(anchor.startLine, total))
  const end = Math.max(start, Math.min(anchor.endLine, total))
  const selected = end - start + 1
  const room = Math.max(0, MAX_FILE_LINES - selected)
  const context = Math.min(WINDOW, Math.floor(room / 2))
  return { from: Math.max(1, start - context), to: Math.min(total, end + context) }
}

/** "lines 40–47", "line 40", or the whole file. */
export function anchorLabel(anchor: AskAnchor): string {
  if (anchor === null) return 'the whole file'
  return anchor.endLine > anchor.startLine
    ? `lines ${anchor.startLine}–${anchor.endLine}`
    : `line ${anchor.startLine}`
}

export function askPayload(input: AskPayloadInput): string {
  const total = input.fileText.split('\n').length
  const { from, to } = spanFor(input.anchor, total)
  const partial = from > 1 || to < total

  const sections = [
    '## What the question is about',
    input.anchor === null
      ? `The whole of ${input.path}.`
      : `${input.path}, ${anchorLabel(input.anchor)}.`,
    '',
    `## ${input.path}`,
    partial
      ? `(${total} lines in all — showing ${from}–${to}; read_file for the rest)`
      : `(${total} lines)`,
    numbered(input.fileText, from, to),
  ]

  if (input.history.length > 0) {
    sections.push('', '## Earlier in this thread')
    for (const turn of input.history) {
      sections.push(`Q: ${turn.question.trim()}`, `A: ${turn.answer.trim()}`, '')
    }
  }

  sections.push('', '## The question', input.question.trim())
  return sections.join('\n')
}
