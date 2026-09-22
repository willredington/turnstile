/**
 * Line numbering, shared by everything that shows a model a file.
 *
 * Lives in core because both the reviewer and the asker need it and they may not import each
 * other — and because a finding or an answer that cites "line 42" is only useful if every
 * surface counts lines the same way.
 */

/** `text`'s lines `from`..`to` (1-based, inclusive), each prefixed with its number. */
export function numbered(text: string, from = 1, to = Number.POSITIVE_INFINITY): string {
  const lines = text.split('\n')
  const start = Math.max(1, from)
  const end = Math.min(lines.length, to)
  const out: string[] = []
  for (let n = start; n <= end; n++) out.push(`${n}\t${lines[n - 1]}`)
  return out.join('\n')
}
