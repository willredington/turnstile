import { createHash } from 'node:crypto'
import type { Annotation } from './types.ts'

/**
 * Notes on lines, and how they reach the agent.
 *
 * The rules here are all about not putting a note in front of the agent that the human did
 * not mean it to have: not twice, not out of order, and not without saying where it is.
 */

/**
 * Notes the agent has not been told about yet, oldest first.
 *
 * Order matters more than it looks. A reader writes notes in the order they read the diff,
 * and that order is an argument; reshuffling it hands the agent the same sentences with the
 * reasoning taken out.
 */
export function unsent(annotations: Annotation[]): Annotation[] {
  return byTime(annotations.filter((annotation) => annotation.sentAt === null))
}

function byTime(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((a, b) => a.at.localeCompare(b.at))
}

/** One file's notes, oldest first. */
export function notesForFile(annotations: Annotation[], root: string, path: string): Annotation[] {
  return byTime(
    annotations.filter((annotation) => annotation.root === root && annotation.path === path),
  )
}

/**
 * Notes on files that are not on the board, oldest first — a file the agent never touched, or
 * one whose change it reverted. Without a place of their own they would be invisible, and still
 * sendable.
 */
export function orphanedAnnotations(
  annotations: Annotation[],
  files: { root: string; path: string }[],
): Annotation[] {
  return byTime(
    annotations.filter(
      (annotation) =>
        !files.some((file) => file.root === annotation.root && file.path === annotation.path),
    ),
  )
}

/**
 * A file's content, fingerprinted — what a note records when it is written, and what it is
 * checked against after every change. A missing file has a fingerprint of its own, so a note on
 * a file that is later deleted (or one written before it existed) still compares correctly.
 */
export function contentHash(content: string | null): string {
  if (content === null) return 'missing'
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

/** The key `staleNotes` looks a file's current hash up by. */
export function noteFileKey(root: string, path: string): string {
  return `${root}\0${path}`
}

/**
 * Entries recorded against a file's content (`fileHash`) whose file has since changed.
 *
 * Entries without a `fileHash` predate it and are never stale; neither is one whose file has no
 * entry in `current` (it could not be read, which is not the same as having changed).
 */
export function changedSince<T extends { root: string; path: string; fileHash?: string }>(
  entries: T[],
  current: ReadonlyMap<string, string>,
): T[] {
  return entries.filter((entry) => {
    if (entry.fileHash === undefined) return false
    const now = current.get(noteFileKey(entry.root, entry.path))
    return now !== undefined && now !== entry.fileHash
  })
}

/**
 * Split file text into lines the way a diff counts them: a trailing newline ends the last
 * line rather than starting an empty one.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The file's lines over a note's range, or null if the file no longer reaches them. */
function quoted(text: string, from: number, to: number): string | null {
  const lines = splitLines(text)
  if (from < 1 || to < from || to > lines.length) return null
  return lines.slice(from - 1, to).join('\n')
}

/**
 * Notes that are no longer about what they were written about, and so must go.
 *
 * A note quotes the lines it was left on, which means it can be checked against exactly those
 * lines rather than against the whole file. Editing a file elsewhere — including editing it
 * yourself, which is the common case now that the document is editable — leaves its notes
 * alone; only a change to the lines a note is actually about retires it. A note that survives
 * still points at the code it was written about, which is the property that matters: a note
 * left on a line it is no longer about is worse than no note.
 *
 * Three cases cannot be checked this way and keep the older, whole-file rule:
 *   - **a note on a removed line**, which is not in the file at all, so nothing in the file
 *     can speak for it — the diff it came from is the only thing that knows, and that is
 *     rebuilt on any change;
 *   - **a note whose file is gone**, which has no lines left to compare; a file that was
 *     already missing when the note was written has not changed, and `contentHash(null)`
 *     is what says so;
 *   - **a note with no `fileHash`**, which predates fingerprinting entirely and is kept.
 *
 * A file with no entry in `texts` could not be read, which is not the same as having changed,
 * so its notes stay.
 */
export function staleNotes(
  annotations: Annotation[],
  texts: ReadonlyMap<string, string | null>,
): Annotation[] {
  return annotations.filter((note) => {
    if (note.fileHash === undefined) return false
    const key = noteFileKey(note.root, note.path)
    if (!texts.has(key)) return false
    const text = texts.get(key) ?? null

    if (note.side === 'old' || text === null) return contentHash(text) !== note.fileHash
    return quoted(text, note.rangeStart, note.line) !== note.lineText
  })
}

/**
 * The notes, written out for the agent.
 *
 * Labelled with the file and line, because an agent that cannot locate a note cannot act on it,
 * and quoted with the line(s) as they read when the note was written, because the agent has the
 * file but not the version of it the human was looking at.
 *
 * Returns an empty string when there is nothing to say, so a caller can concatenate without
 * having to check.
 */
export function annotationsBlock(annotations: Annotation[]): string {
  if (annotations.length === 0) return ''

  const sections: string[] = ['The human left notes on specific lines:', '']
  for (const annotation of annotations) {
    const where =
      annotation.rangeStart < annotation.line
        ? `${annotation.path}:${annotation.rangeStart}-${annotation.line}`
        : `${annotation.path}:${annotation.line}`
    const side = annotation.side === 'old' ? ' (a line you removed)' : ''
    sections.push(`- ${where}${side} — ${annotation.body}`)
    for (const line of annotation.lineText.trim().split('\n')) sections.push(`    > ${line}`)
  }
  return sections.join('\n')
}

/**
 * A prompt with notes attached.
 *
 * Notes lead. They are about code the agent has already written, so they are the correction;
 * the typed message is what to do next, and reading the correction first is what makes the
 * instruction make sense.
 */
export function promptWith(annotations: Annotation[], text: string): string {
  const block = annotationsBlock(annotations)
  if (block === '') return text
  return text.trim() === '' ? block : `${block}\n\n${text}`
}

/**
 * The stand-in path a plan's notes are anchored to.
 *
 * A plan is not a file, so nothing may resolve this against the filesystem — it exists only so a
 * note on a plan can satisfy `Annotation` and be rendered by the cards the document surface
 * already has. It reads as a phrase rather than a filename so that anywhere it does leak into
 * view, it says what it is instead of pretending to be a path.
 */
export const PLAN_PATH = 'the plan'

/**
 * Notes on a plan, written out as the reason it is being refused.
 *
 * Unlike `annotationsBlock` this is not a prompt: it becomes the `ExitPlanMode` tool call's deny
 * message, which is the whole of what the blocked agent is told. So it says what it is in its
 * first line — the plan was not accepted — rather than opening with notes the agent has no frame
 * for.
 *
 * Anchors are labelled as lines of the plan, not as `path:line`: `PLAN_PATH` is a stand-in, and
 * printing it would invite the agent to go looking for a file that does not exist. The lines are
 * quoted the same way `annotationsBlock` quotes them, because the agent is about to rewrite the
 * plan and needs to see which part of it each objection lands on.
 *
 * Returns `''` when there is nothing to say, so a caller can test for that rather than
 * discovering it in the agent's transcript.
 */
export function planRefusal(notes: Annotation[], message: string): string {
  const text = message.trim()
  if (notes.length === 0 && text === '') return ''

  const parts: string[] = []
  if (notes.length > 0) {
    const sections: string[] = ['The human did not accept this plan, and left notes on it:', '']
    for (const note of byTime(notes)) {
      const where =
        note.rangeStart < note.line ? `lines ${note.rangeStart}-${note.line}` : `line ${note.line}`
      sections.push(`- ${where} — ${note.body}`)
      for (const line of note.lineText.trim().split('\n')) sections.push(`    > ${line}`)
    }
    parts.push(sections.join('\n'))
  }
  if (text !== '') parts.push(text)
  parts.push(REVISE)
  return parts.join('\n\n')
}

/**
 * What to do about it, said outright.
 *
 * Without this the refusal is a list of objections and nothing else, which reads as a remark —
 * and got treated as one: handed a plan's notes, the agent discussed them, asked a clarifying
 * question, and never submitted anything, so no revised plan could ever arrive. Live, the
 * refusal at least rides back as the `ExitPlanMode` call's own error, where Claude Code's plan
 * mode supplies that expectation itself. Recovered from a resumed session it is an ordinary
 * message with none of that around it, so it has to carry the expectation on its own.
 */
const REVISE =
  'Revise the plan to address this and submit the new version with ExitPlanMode. Do not start ' +
  'the work, and do not reply with the changes in prose — the revised plan has to come back ' +
  'through ExitPlanMode so it can be reviewed.'
