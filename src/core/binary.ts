/**
 * Whether a file's bytes are binary rather than text.
 *
 * This exists because every file-viewing surface renders a file one line at a time, and a
 * binary file has no meaningful lines: decoded as UTF-8 a PDF becomes a handful of enormous
 * ones — a 287KB sample measured 155 lines with a single line of 154,193 characters — and
 * `white-space: pre` then forces the browser to lay each out as one unwrapped run. That is
 * synchronous work on the main thread, it is linear in the file's size, and it is roughly
 * 14x more expensive per character for binary content than for ASCII (measured: 86ms vs 6ms
 * for the same 154,193 characters) because the byte soup spans hundreds of distinct code
 * points and forces font fallback. A few megabytes of PDF freezes the whole app.
 *
 * The signal is a NUL byte, which is what git itself uses to classify a blob as binary. It
 * separates cleanly in practice: every PDF and PNG sampled while writing this carried NULs
 * within the first few hundred bytes (26-653 in the first 8000), while this repository's own
 * source, JSON, Markdown and lockfiles carried none at all. A high-bytes or control-character
 * ratio was deliberately not used instead: ordinary UTF-8 text is full of high bytes, so that
 * heuristic risks refusing to open a perfectly good file — a much worse failure than
 * rendering an exotic binary that happens to have no NUL in its first 8000 bytes.
 */

/** How much of a file to sniff. Bounded, like git's, so the check costs the same for a
 *  10-byte file and a 10GB one — it runs on every file the browser opens. */
export const BINARY_SNIFF_BYTES = 8000

export function looksBinary(content: Uint8Array): boolean {
  const end = Math.min(content.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (content[i] === 0) return true
  }
  return false
}
