/**
 * What the file will contain if this edit is allowed to proceed.
 *
 * `oldText === null` means a whole-file write (create or full replace): `newText` is the
 * complete proposed content and `current` is irrelevant. Otherwise this is an Edit-style
 * snippet substitution — `old_string` is documented (by the underlying tool) to be unique
 * within the file, so a first-occurrence replace is exact, not an approximation.
 */
export function proposedContent(
  current: string | null,
  oldText: string | null,
  newText: string,
): string {
  if (oldText === null) return newText
  if (current === null) return newText
  // A function replacer, deliberately. Passing `newText` as a plain string makes
  // `String.prototype.replace` read `$&`, `$'`, `` $` ``, `$$`, `$1`… inside it as
  // substitution patterns rather than as text — so an agent writing a shell quoting idiom or
  // a regex snippet would be reviewed on content that is not what will actually land, under
  // a chunk key that will not match the real post-write one. A function replacer is never
  // pattern-interpreted.
  return current.replace(oldText, () => newText)
}

/**
 * Whether a proposed edit's `old_text` is usable against the file's current content, before
 * any diff is computed. `String.prototype.replace` (what `proposedContent` uses) silently
 * no-ops on a non-matching search value rather than failing — left unchecked, that turns a
 * mistaken `old_text` into a no-op "success" instead of the rejection it should be.
 */
export function resolveEdit(
  path: string,
  current: string | null,
  oldText: string | null,
): { ok: true } | { ok: false; message: string } {
  if (oldText === null) return { ok: true }
  if (current === null) {
    return { ok: false, message: `${path} does not exist yet — omit old_text to create it.` }
  }
  if (!current.includes(oldText)) {
    return {
      ok: false,
      message: `old_text was not found in ${path} exactly as given. Read the file and retry with the exact current text.`,
    }
  }
  return { ok: true }
}
