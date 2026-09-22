import { readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from '../../core/config.ts'
import type { AnalysisCache } from '../../core/ports.ts'
import type { FileReview } from '../../core/types.ts'

/**
 * File reviews cached as flat files under `.turnstile/cache/`.
 *
 * Flat and human-inspectable on purpose: when the gate shows something surprising, being
 * able to `cat` the exact analysis it used is worth more than a compact format.
 *
 * Every operation is best-effort. A cache failure must degrade to "analyze it now", never
 * to a broken gate — the cache is a latency optimisation, not a source of truth.
 */

/** A claim older than this is treated as abandoned, so a crashed worker cannot wedge a key. */
const STALE_CLAIM_MS = 2 * 60 * 1000

function cacheDir(cwd: string): string {
  return join(cwd, STATE_DIR, 'cache')
}

/** Keys are hex digests, but this is defence against a malformed one reaching a path. */
function isSafeKey(key: string): boolean {
  return /^[a-f0-9]{8,64}$/.test(key)
}

export function createFileAnalysisCache(cwd: string): AnalysisCache {
  const dir = cacheDir(cwd)
  const entryPath = (key: string) => join(dir, `${key}.json`)
  const claimPath = (key: string) => join(dir, `${key}.claim`)

  return {
    get: async (key) => {
      if (!isSafeKey(key)) return null
      try {
        const file = Bun.file(entryPath(key))
        if (!(await file.exists())) return null
        const raw = (await file.json()) as Partial<FileReview>
        // A half-written or hand-edited entry — or one from the per-chunk risk check this
        // replaced — must not surface as a review.
        if (!Array.isArray(raw.findings)) return null
        return raw as FileReview
      } catch {
        return null
      }
    },

    put: async (key, review) => {
      if (!isSafeKey(key)) return
      try {
        await Bun.write(entryPath(key), `${JSON.stringify(review, null, 2)}\n`)
      } catch {
        // Losing a cache write costs a re-analysis, not correctness.
      }
    },

    /**
     * Exclusive-create as the lock: `Bun.write` has no such flag, so the claim is a file
     * whose prior existence is checked first. This races under true concurrency, which is
     * acceptable — the cost of a lost race is duplicated model work, never a wrong result.
     */
    claim: async (key) => {
      if (!isSafeKey(key)) return false
      try {
        const file = Bun.file(claimPath(key))
        if (await file.exists()) {
          const age = Date.now() - (await file.stat()).mtimeMs
          if (age < STALE_CLAIM_MS) return false
          // Stale: the worker that held it died. Take it over.
        }
        await Bun.write(claimPath(key), String(Date.now()))
        return true
      } catch {
        return false
      }
    },

    release: async (key) => {
      if (!isSafeKey(key)) return
      try {
        await unlink(claimPath(key))
      } catch {
        // Already gone, or never written.
      }
    },

    prune: async (keepKeys) => {
      try {
        const keep = new Set(keepKeys)
        for (const name of await readdir(dir)) {
          const key = name.replace(/\.(json|claim)$/, '')
          if (!keep.has(key)) await rm(join(dir, name), { force: true })
        }
      } catch {
        // No cache directory yet, or an unreadable one. Nothing to prune.
      }
    },
  }
}
