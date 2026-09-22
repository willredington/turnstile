import { describe, expect, test } from 'bun:test'
import {
  boardKey,
  COALESCE_GAP,
  chunkKey,
  chunkPatch,
  MAX_ANALYSIS_LINES,
  MAX_CHUNK_LINES,
  unanalyzedReason,
} from '../../src/core/chunking.ts'
import { parsePatch } from '../../src/core/patch.ts'

const ROOT = '/repo'

/** Build a patch with hunks at the given new-side starts, each one changed line. */
function patchWithHunksAt(starts: number[], path = 'src/x.ts'): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`
  const hunks = starts.map((start) => `@@ -${start},1 +${start},1 @@\n-old${start}\n+new${start}`)
  return [header, ...hunks].join('\n')
}

function chunksOf(patch: string, root = ROOT) {
  return chunkPatch(parsePatch(patch), root)
}

describe('coalescing', () => {
  test('merges hunks closer than the gap into one chunk', () => {
    expect(chunksOf(patchWithHunksAt([10, 12])).length).toBe(1)
  })

  test('keeps hunks further apart than the gap separate', () => {
    expect(chunksOf(patchWithHunksAt([10, 200])).length).toBe(2)
  })

  test('the gap is the boundary', () => {
    const within = chunksOf(patchWithHunksAt([10, 10 + COALESCE_GAP - 1]))
    const beyond = chunksOf(patchWithHunksAt([10, 10 + COALESCE_GAP + 4]))
    expect(within.length).toBe(1)
    expect(beyond.length).toBe(2)
  })

  test('chains a run of nearby hunks into a single chunk', () => {
    expect(chunksOf(patchWithHunksAt([10, 12, 14, 16])).length).toBe(1)
  })
})

describe('splitting', () => {
  /** A wide refactor must not become one unreviewable mega-chunk. */
  test('splits a run that exceeds the chunk budget', () => {
    const starts = Array.from({ length: MAX_CHUNK_LINES }, (_, i) => 10 + i * 2)
    const chunks = chunksOf(patchWithHunksAt(starts))
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('every split piece stays within the budget', () => {
    const starts = Array.from({ length: MAX_CHUNK_LINES }, (_, i) => 10 + i * 2)
    for (const chunk of chunksOf(patchWithHunksAt(starts))) {
      expect(chunk.addedCount + chunk.removedCount).toBeLessThanOrEqual(MAX_CHUNK_LINES + 2)
    }
  })

  test('leaves a small change as one chunk', () => {
    expect(chunksOf(patchWithHunksAt([10])).length).toBe(1)
  })
})

describe('whole-file changes', () => {
  const deletion = (lines: number) =>
    [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      `@@ -1,${lines} +0,0 @@`,
      ...Array.from({ length: lines }, (_, i) => `-line ${i}`),
    ].join('\n')

  /** A 55-line deletion is one decision, not five. */
  test('a deletion is never split, however large', () => {
    const chunks = chunksOf(deletion(300))
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.wholeFile).toBe(true)
  })

  test('a creation is never split either', () => {
    const created = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,300 @@',
      ...Array.from({ length: 300 }, (_, i) => `+line ${i}`),
    ].join('\n')
    expect(chunksOf(created).length).toBe(1)
  })

  test('a modest deletion is still analyzed', () => {
    expect(chunksOf(deletion(20))[0]?.analyzable).toBe(true)
  })
})

describe('the analysis budget', () => {
  /**
   * The budget governs what is sent to a model, never what the human sees. An unanalyzed
   * chunk still carries every line of its diff.
   */
  test('marks an oversized chunk unanalyzable but keeps all its content', () => {
    const lines = MAX_ANALYSIS_LINES + 50
    const huge = [
      'diff --git a/big.ts b/big.ts',
      'deleted file mode 100644',
      '--- a/big.ts',
      '+++ /dev/null',
      `@@ -1,${lines} +0,0 @@`,
      ...Array.from({ length: lines }, (_, i) => `-line ${i}`),
    ].join('\n')

    const chunk = chunksOf(huge)[0]
    expect(chunk?.analyzable).toBe(false)
    expect(chunk?.removedCount).toBe(lines)
    expect(chunk?.hunks[0]?.lines.length).toBe(lines)
  })

  test('never analyzes binary content, but still yields a chunk to review', () => {
    const chunks = chunksOf(`diff --git a/img.png b/img.png
index aaa..bbb 100644
Binary files a/img.png and b/img.png differ`)
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.analyzable).toBe(false)
    expect(unanalyzedReason(chunks[0] as never)).toContain('binary')
  })

  test('explains why an oversized chunk was skipped', () => {
    const lines = MAX_ANALYSIS_LINES + 10
    const huge = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      `@@ -1,${lines} +1,0 @@`,
      ...Array.from({ length: lines }, (_, i) => `-line ${i}`),
    ].join('\n')
    expect(unanalyzedReason(chunksOf(huge)[0] as never)).toContain('too large')
  })
})

/**
 * The property the entire cache rests on. If keys are not stable across unrelated edits,
 * precomputation silently stops paying and every turn re-analyzes everything.
 */
describe('chunk key stability', () => {
  const base = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,3 +10,3 @@ function f()
 context
-old line
+new line`

  const keyOf = (patch: string) => chunksOf(patch)[0]?.key

  test('is unchanged when the hunk merely moves down the file', () => {
    const shifted = base.replace('@@ -10,3 +10,3 @@', '@@ -420,3 +438,3 @@')
    expect(keyOf(shifted)).toBe(keyOf(base) as string)
  })

  test('changes when the content changes', () => {
    expect(keyOf(base.replace('+new line', '+different line'))).not.toBe(keyOf(base) as string)
  })

  test('changes when the file path changes', () => {
    expect(keyOf(base.replaceAll('x.ts', 'y.ts'))).not.toBe(keyOf(base) as string)
  })

  test('returns to the original key when an edit is reverted', () => {
    const edited = base.replace('+new line', '+temporary')
    expect(keyOf(edited)).not.toBe(keyOf(base) as string)
    expect(keyOf(base)).toBe(keyOf(base) as string)
  })

  test('distinguishes identical changes made in two places in one file', () => {
    const twice = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,1 +10,1 @@
-same
+same edit
@@ -200,1 +200,1 @@
-same
+same edit`
    const chunks = chunksOf(twice)
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.key).not.toBe(chunks[1]?.key as string)
  })

  test('is deterministic across calls', () => {
    expect(keyOf(base)).toBe(keyOf(base) as string)
  })
})

describe('chunkKey', () => {
  test('ignores line numbers entirely', () => {
    const hunks = parsePatch(`@@ -1,1 +1,1 @@\n-a\n+b`).hunks
    const shifted = parsePatch(`@@ -900,1 +900,1 @@\n-a\n+b`).hunks
    expect(chunkKey('x.ts', hunks, 0)).toBe(chunkKey('x.ts', shifted, 0))
  })

  test('separates copies of the same change', () => {
    const hunks = parsePatch(`@@ -1,1 +1,1 @@\n-a\n+b`).hunks
    expect(chunkKey('x.ts', hunks, 0)).not.toBe(chunkKey('x.ts', hunks, 1))
  })
})

describe('boardKey', () => {
  test('is deterministic for the same root and key', () => {
    expect(boardKey('/repo', 'abc')).toBe(boardKey('/repo', 'abc'))
  })

  test('differs across roots for the identical bare key', () => {
    // The whole reason this exists: two roots can independently produce the same chunkKey()
    // (same relative path, same diff) — the live board's wire identity must still tell them
    // apart.
    expect(boardKey('/repoA', 'abc')).not.toBe(boardKey('/repoB', 'abc'))
  })

  test('differs across keys for the identical root', () => {
    expect(boardKey('/repo', 'abc')).not.toBe(boardKey('/repo', 'def'))
  })
})

/**
 * A key carries an approval, so what changes it decides what comes back unreviewed.
 *
 * The counter is over copies of the same body, not position in the file. Position would mean
 * inserting an unrelated change near the top of a file re-identified every chunk below it —
 * and on a board where approvals are keyed by content, that resurrects work the human has
 * already signed off on. It reads as the tool forgetting.
 */
describe('identity under insertion', () => {
  const later = `@@ -200,1 +200,1 @@\n-stable\n+stable edit`
  const header = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts`

  test('a chunk keeps its key when another is added above it', () => {
    const before = chunksOf(`${header}\n${later}`)
    const after = chunksOf(`${header}\n@@ -10,1 +10,1 @@\n-new\n+new edit\n${later}`)

    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
    expect(after[1]?.key).toBe(before[0]?.key as string)
  })

  test('and when one is removed from above it', () => {
    const withBoth = chunksOf(`${header}\n@@ -10,1 +10,1 @@\n-new\n+new edit\n${later}`)
    const withOne = chunksOf(`${header}\n${later}`)

    expect(withOne[0]?.key).toBe(withBoth[1]?.key as string)
  })

  /** The property the counter exists for, which insertion-independence must not cost. */
  test('two identical changes in one file are still two decisions', () => {
    const twice = chunksOf(
      `${header}\n@@ -10,1 +10,1 @@\n-same\n+same edit\n@@ -200,1 +200,1 @@\n-same\n+same edit`,
    )

    expect(twice).toHaveLength(2)
    expect(twice[0]?.key).not.toBe(twice[1]?.key as string)
  })

  /** Copies are numbered in file order, so which key is which does not flap between runs. */
  test('numbering copies is stable across recomputes', () => {
    const patch = `${header}\n@@ -10,1 +10,1 @@\n-same\n+same edit\n@@ -200,1 +200,1 @@\n-same\n+same edit`
    expect(chunksOf(patch).map((chunk) => chunk.key)).toEqual(
      chunksOf(patch).map((chunk) => chunk.key),
    )
  })
})

describe('chunk metadata', () => {
  test('carries a new-side region for diffLocation', () => {
    const chunk = chunksOf(patchWithHunksAt([42]))[0]
    expect(chunk?.startLine).toBe(42)
    expect(chunk?.endLine).toBeGreaterThanOrEqual(42)
  })

  test('carries the previous path across a rename', () => {
    const chunk = chunksOf(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-a
+b`)[0]
    expect(chunk?.path).toBe('new.ts')
    expect(chunk?.previousPath).toBe('old.ts')
  })
})
