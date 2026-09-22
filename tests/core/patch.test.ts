import { describe, expect, test } from 'bun:test'
import {
  changedLineCount,
  gapBetween,
  hunkRange,
  parseHunks,
  parsePatch,
} from '../../src/core/patch.ts'

/** The exact patch from the bug report that prompted the diff rewrite. */
const DELETED_FILE = `diff --git a/tailwind.config.mjs b/tailwind.config.mjs
deleted file mode 100644
index c1f3643..0000000
--- a/tailwind.config.mjs
+++ /dev/null
@@ -1,5 +0,0 @@
-/** @type {import('tailwindcss').Config} */
-export default {
-  content: ["./src/**/*.{astro,html,js}"],
-  darkMode: "class",
-};`

const MODIFIED = `diff --git a/src/orders.ts b/src/orders.ts
index 27575aa..698b239 100644
--- a/src/orders.ts
+++ b/src/orders.ts
@@ -10,4 +10,5 @@ export function orderTotal(order: Order) {
 const items = order.items
-return items.length
+return items.reduce((sum, i) => sum + i.price, 0)
+// totals now include price
 }`

describe('parsePatch', () => {
  test('never surfaces git plumbing as content', () => {
    const parsed = parsePatch(MODIFIED)
    const text = parsed.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('\n')

    for (const plumbing of ['diff --git', 'index 27575aa', '--- a/', '+++ b/']) {
      expect(text).not.toContain(plumbing)
    }
  })

  test('reads the path and change counts', () => {
    const parsed = parsePatch(MODIFIED)
    expect(parsed.path).toBe('src/orders.ts')
    expect(parsed.kind).toBe('modified')
    expect(parsed.addedCount).toBe(2)
    expect(parsed.removedCount).toBe(1)
  })

  test('captures the function context git puts after the @@', () => {
    expect(parsePatch(MODIFIED).hunks[0]?.context).toBe(
      'export function orderTotal(order: Order) {',
    )
  })

  describe('line numbering', () => {
    test('numbers additions on the new side only', () => {
      const added = parsePatch(MODIFIED).hunks[0]?.lines.find((l) => l.kind === 'add')
      expect(added?.oldLine).toBeNull()
      expect(added?.newLine).toBe(11)
    })

    test('numbers removals on the old side only', () => {
      const removed = parsePatch(MODIFIED).hunks[0]?.lines.find((l) => l.kind === 'remove')
      expect(removed?.newLine).toBeNull()
      expect(removed?.oldLine).toBe(11)
    })

    test('advances both sides across context', () => {
      const context = parsePatch(MODIFIED).hunks[0]?.lines.filter((l) => l.kind === 'context')
      expect(context?.[0]).toMatchObject({ oldLine: 10, newLine: 10 })
    })

    test('keeps numbering correct across multiple hunks', () => {
      const parsed = parsePatch(`--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-a
+b
@@ -50,2 +50,2 @@
-c
+d`)
      expect(parsed.hunks[1]?.lines[0]).toMatchObject({ kind: 'remove', oldLine: 50 })
      expect(parsed.hunks[1]?.lines[1]).toMatchObject({ kind: 'add', newLine: 50 })
    })
  })

  describe('file lifecycle', () => {
    test('recognises a deletion', () => {
      const parsed = parsePatch(DELETED_FILE)
      expect(parsed.kind).toBe('deleted')
      expect(parsed.path).toBe('tailwind.config.mjs')
      expect(parsed.removedCount).toBe(5)
    })

    /** The reviewer must still be able to read every deleted line. */
    test('keeps every line of a deleted file', () => {
      const lines = parsePatch(DELETED_FILE).hunks[0]?.lines ?? []
      expect(lines.length).toBe(5)
      expect(lines[0]?.text).toContain('tailwindcss')
    })

    test('recognises a creation', () => {
      const parsed = parsePatch(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2`)
      expect(parsed.kind).toBe('created')
      expect(parsed.addedCount).toBe(2)
    })

    test('recognises a rename and keeps the old path', () => {
      const parsed = parsePatch(`diff --git a/old.ts b/new.ts
similarity index 92%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-a
+b`)
      expect(parsed.kind).toBe('renamed')
      expect(parsed.path).toBe('new.ts')
      expect(parsed.previousPath).toBe('old.ts')
    })

    test('recognises binary content', () => {
      const parsed = parsePatch(`diff --git a/img.png b/img.png
index aaa..bbb 100644
Binary files a/img.png and b/img.png differ`)
      expect(parsed.kind).toBe('binary')
      expect(parsed.hunks).toEqual([])
    })
  })

  describe('tolerance', () => {
    test('ignores the no-newline marker without treating it as content', () => {
      const parsed = parsePatch(`--- a/x
+++ b/x
@@ -1 +1 @@
-a
\\ No newline at end of file
+b`)
      expect(parsed.addedCount).toBe(1)
      expect(parsed.removedCount).toBe(1)
      expect(parsed.hunks[0]?.lines.length).toBe(2)
    })

    test('handles paths containing spaces', () => {
      expect(parsePatch('diff --git a/my file.ts b/my file.ts').path).toBe('my file.ts')
    })

    test('returns an empty patch rather than throwing on junk', () => {
      const parsed = parsePatch('not a patch at all')
      expect(parsed.hunks).toEqual([])
      expect(parsed.addedCount).toBe(0)
    })

    test('falls back to a supplied path when the header is absent', () => {
      expect(parsePatch('@@ -1 +1 @@\n-a\n+b', 'src/x.ts').path).toBe('src/x.ts')
    })
  })
})

describe('hunkRange', () => {
  /** Leading context through trailing context: 10 ctx, 11 add, 12 add, 13 ctx. */
  test('spans the new-side lines a hunk covers, context included', () => {
    expect(hunkRange(parsePatch(MODIFIED).hunks[0] as never)).toEqual({
      startLine: 10,
      endLine: 13,
    })
  })

  /** A pure deletion has no new side, so the range anchors where the deletion sits. */
  test('anchors a pure deletion rather than inverting', () => {
    const hunk = parsePatch('@@ -3,2 +2,0 @@\n-gone\n-also').hunks[0] as never
    const range = hunkRange(hunk)
    expect(range.startLine).toBe(2)
    expect(range.endLine).toBe(2)
  })
})

describe('changedLineCount', () => {
  test('counts additions and removals but not context', () => {
    expect(changedLineCount(parsePatch(MODIFIED).hunks)).toBe(3)
  })
})

describe('gapBetween', () => {
  test('measures unchanged lines separating two hunks', () => {
    const parsed = parsePatch(`--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-a
+b
@@ -20,1 +20,1 @@
-c
+d`)
    expect(gapBetween(parsed.hunks[0] as never, parsed.hunks[1] as never)).toBeGreaterThan(6)
  })

  test('is zero for touching hunks', () => {
    const parsed = parsePatch(`--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-a
+b
@@ -2,1 +2,1 @@
-c
+d`)
    expect(gapBetween(parsed.hunks[0] as never, parsed.hunks[1] as never)).toBe(0)
  })
})

/**
 * Regression: real git output ends with a newline, so `split('\n')` leaves a trailing
 * empty element. Treating it as context appended a phantom line to the last hunk — which
 * changed that hunk's content hash the moment another hunk appeared after it, silently
 * destroying the cache hit rate.
 */
describe('trailing newline', () => {
  const oneHunk =
    'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n ctx\n'

  test('does not append a phantom context line', () => {
    const withNewline = parsePatch(oneHunk)
    const without = parsePatch(oneHunk.trimEnd())
    expect(withNewline.hunks[0]?.lines.length).toBe(without.hunks[0]?.lines.length as number)
  })

  test('leaves a hunk identical whether or not another hunk follows it', () => {
    const alone = parsePatch(oneHunk)
    const followed = parsePatch(`${oneHunk}@@ -50,1 +50,1 @@\n-c\n+d\n`)

    const render = (hunk: { lines: { kind: string; text: string }[] }) =>
      hunk.lines.map((l) => `${l.kind}:${l.text}`).join('|')

    expect(render(followed.hunks[0] as never)).toBe(render(alone.hunks[0] as never))
  })

  test('does not inflate the line range', () => {
    expect(hunkRange(parsePatch(oneHunk).hunks[0] as never).endLine).toBe(2)
  })
})

describe('parseHunks', () => {
  test('extracts hunk ranges and changed-line content', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-removed line',
      '+added line one',
      '+added line two',
      ' trailing context',
      '',
    ].join('\n')

    const result = parseHunks(patch)
    expect(result.binary).toBe(false)
    expect(result.hunks).toEqual([{ startLine: 1, endLine: 4 }])
    expect(result.addedLines).toEqual(['added line one', 'added line two'])
    expect(result.removedLines).toEqual(['removed line'])
  })

  test('detects a binary file marker', () => {
    const result = parseHunks('Binary files a/image.png and b/image.png differ\n')
    expect(result).toEqual({ hunks: [], addedLines: [], removedLines: [], binary: true })
  })

  test('ignores file-header and no-newline marker lines', () => {
    const patch = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const result = parseHunks(patch)
    expect(result.addedLines).toEqual(['new'])
    expect(result.removedLines).toEqual(['old'])
  })
})
