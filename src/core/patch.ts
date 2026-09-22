import type { Hunk, ParsedPatch, PatchHunk, PatchKind, PatchLine } from './types.ts'

/**
 * Unified-diff parsing.
 *
 * Everything downstream — chunking, hashing, rendering — works from this structure rather
 * than from patch text. Two consequences worth stating: git plumbing never reaches the
 * page, and every line carries its old/new number so a reader can find it in their editor.
 *
 * Nothing here truncates. A patch too large to *analyze* is still parsed and still
 * rendered in full; the size budget lives in chunking and governs model calls only.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

const HUNK_HEADER_SIMPLE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse a single-file unified patch into hunk ranges and changed-line content.
 *
 * Pure text parsing with no I/O, so it lives in `core`: `app/` needs it for a synthetic
 * (not-yet-on-disk) diff, and `adapters/git/delta.ts` parses `git diff` output with it.
 *
 * Ranges are expressed in NEW-file line numbers, which is what a reviewer opening the
 * file will actually see. For a deleted file there is no new side, so the range is
 * reported as the old side's extent instead.
 */
export function parseHunks(patch: string): {
  hunks: Hunk[]
  addedLines: string[]
  removedLines: string[]
  binary: boolean
} {
  if (/^Binary files .* differ$/m.test(patch)) {
    return { hunks: [], addedLines: [], removedLines: [], binary: true }
  }

  const hunks: Hunk[] = []
  const addedLines: string[] = []
  const removedLines: string[] = []

  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER_SIMPLE.exec(line)
    if (header !== null) {
      const start = Number(header[1])
      const count = header[2] === undefined ? 1 : Number(header[2])
      // A zero-length new side (pure deletion hunk) still needs a nonempty range to
      // point at; anchor it at the line the deletion sits between.
      hunks.push({ startLine: start, endLine: count === 0 ? start : start + count - 1 })
      continue
    }
    // `---`/`+++` are file headers, not content. `\ No newline at end of file` is a
    // marker, not a changed line.
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue
    if (line.startsWith('+')) addedLines.push(line.slice(1))
    else if (line.startsWith('-')) removedLines.push(line.slice(1))
  }

  return { hunks, addedLines, removedLines, binary: false }
}

/** Header lines that describe the patch rather than the content. */
function isPlumbing(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('dissimilarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('copy from ') ||
    line.startsWith('copy to ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  )
}

function stripPrefix(path: string): string {
  if (path === '/dev/null') return path
  return path.replace(/^[ab]\//, '')
}

/** Paths in `diff --git a/x b/y`; quoted when they contain unusual characters. */
function parseGitHeader(line: string): { old: string; next: string } | null {
  const rest = line.slice('diff --git '.length)

  const quoted = /^"(.*)" "(.*)"$/.exec(rest)
  if (quoted !== null) {
    return { old: stripPrefix(quoted[1] as string), next: stripPrefix(quoted[2] as string) }
  }

  // Unquoted paths may contain spaces, so split on the midpoint of the two `a/` `b/` runs
  // rather than on the first space.
  const midpoint = rest.indexOf(' b/')
  if (midpoint > 0) {
    return {
      old: stripPrefix(rest.slice(0, midpoint)),
      next: stripPrefix(rest.slice(midpoint + 1)),
    }
  }

  const parts = rest.split(' ')
  if (parts.length === 2) {
    return { old: stripPrefix(parts[0] as string), next: stripPrefix(parts[1] as string) }
  }
  return null
}

/**
 * Parse the patch for a single file.
 *
 * `fallbackPath` is used when the patch carries no `diff --git` header — which happens
 * when callers ask git for a bare hunk listing.
 */
export function parsePatch(patch: string, fallbackPath = ''): ParsedPatch {
  const lines = patch.split('\n')

  // Real git output ends with a newline, so the split leaves a trailing empty element.
  // Treating it as an empty context line appends a phantom line to whichever hunk happens
  // to be last — which shifts that hunk's content and therefore its cache key, so an
  // untouched region would miss the cache the moment another hunk appeared after it.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let path = fallbackPath
  let previousPath: string | undefined
  let kind: PatchKind = 'modified'
  let sawNewFile = false
  let sawDeletedFile = false
  let sawRename = false

  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let oldLine = 0
  let newLine = 0
  let addedCount = 0
  let removedCount = 0

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = parseGitHeader(line)
      if (paths !== null) {
        path = paths.next === '/dev/null' ? paths.old : paths.next
        if (paths.old !== paths.next && paths.old !== '/dev/null') previousPath = paths.old
      }
      continue
    }

    if (line.startsWith('new file mode ')) {
      sawNewFile = true
      continue
    }
    if (line.startsWith('deleted file mode ')) {
      sawDeletedFile = true
      continue
    }
    if (line.startsWith('rename from ')) {
      sawRename = true
      previousPath = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      sawRename = true
      path = line.slice('rename to '.length)
      continue
    }

    if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
      kind = 'binary'
      continue
    }

    // `--- /dev/null` and `+++ /dev/null` also identify creation and deletion, for patches
    // that carry no mode lines.
    if (line.startsWith('--- ')) {
      if (stripPrefix(line.slice(4).trim()) === '/dev/null') sawNewFile = true
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = stripPrefix(line.slice(4).trim())
      if (target === '/dev/null') sawDeletedFile = true
      else if (path === '') path = target
      continue
    }

    if (isPlumbing(line)) continue

    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = {
        oldStart: oldLine,
        newStart: newLine,
        context: (header[5] ?? '').trim(),
        lines: [],
      }
      hunks.push(current)
      continue
    }

    if (current === null) continue

    // A marker, not content — it annotates the preceding line.
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', oldLine: null, newLine, text: line.slice(1) })
      newLine += 1
      addedCount += 1
      continue
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'remove', oldLine, newLine: null, text: line.slice(1) })
      oldLine += 1
      removedCount += 1
      continue
    }
    if (line.startsWith(' ') || line === '') {
      current.lines.push({ kind: 'context', oldLine, newLine, text: line.slice(1) })
      oldLine += 1
      newLine += 1
    }
  }

  if (kind !== 'binary') {
    if (sawNewFile && !sawDeletedFile) kind = 'created'
    else if (sawDeletedFile && !sawNewFile) kind = 'deleted'
    else if (sawRename || previousPath !== undefined) kind = 'renamed'
  }

  return {
    kind,
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    addedCount,
    removedCount,
    hunks,
  }
}

/** New-file line range a hunk covers, used for `diffLocation`. */
export function hunkRange(hunk: PatchHunk): { startLine: number; endLine: number } {
  const numbered = hunk.lines.filter((line) => line.newLine !== null)
  if (numbered.length === 0) {
    // A pure deletion has no new side; anchor it where the deletion sits.
    return { startLine: hunk.newStart, endLine: hunk.newStart }
  }
  const first = numbered[0] as PatchLine
  const last = numbered[numbered.length - 1] as PatchLine
  return { startLine: first.newLine as number, endLine: last.newLine as number }
}

/** Changed lines only. Context does not count toward any budget. */
export function changedLineCount(hunks: PatchHunk[]): number {
  return hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind !== 'context').length,
    0,
  )
}

/**
 * Unchanged lines between the end of one hunk and the start of the next, in new-file
 * coordinates. Drives coalescing.
 */
export function gapBetween(earlier: PatchHunk, later: PatchHunk): number {
  const end = hunkRange(earlier).endLine
  return Math.max(0, later.newStart - end - 1)
}
