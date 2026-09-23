import { join } from 'node:path'
import { STATE_DIR } from '../../core/config.ts'
import type { FindingStore } from '../../core/ports.ts'
import type { StoredReview } from '../../core/types.ts'

/**
 * Each session's file reviews, in `.turnstile/findings.json`.
 *
 * One flat file, every session's entries together, the same way notes and hidden files are kept:
 * every read and write is session-scoped, and every write carries every other entry over exactly
 * as stored.
 *
 * Reads degrade to "nothing reviewed" — the worst that costs is a file reading "not reviewed"
 * until it is reviewed again. Writes throw, so a lost review is reported rather than silently
 * missing on the next resume.
 */

type StoredEntry = StoredReview & { sessionId: string }
type FindingsFile = { reviews: unknown[] }

export function findingsPath(cwd: string): string {
  return join(cwd, STATE_DIR, 'findings.json')
}

function isEntry(raw: unknown): raw is StoredEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const record = raw as Partial<StoredEntry>
  return (
    typeof record.sessionId === 'string' &&
    typeof record.root === 'string' &&
    typeof record.path === 'string' &&
    typeof record.fileHash === 'string' &&
    Array.isArray(record.findings)
  )
}

export function createFileFindingStore(cwd: string): FindingStore {
  const path = findingsPath(cwd)

  const readRaw = async (): Promise<unknown[]> => {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return []
      const raw = (await file.json()) as Partial<FindingsFile>
      return Array.isArray(raw.reviews) ? raw.reviews : []
    } catch {
      return []
    }
  }

  return {
    bySession: async (sessionId) =>
      (await readRaw())
        .filter((raw): raw is StoredEntry => isEntry(raw) && raw.sessionId === sessionId)
        .map(({ sessionId: _, ...review }) => review),

    put: async (sessionId, reviews) => {
      if (reviews.length === 0) return
      const replaced = (raw: unknown) =>
        isEntry(raw) &&
        raw.sessionId === sessionId &&
        reviews.some((review) => review.root === raw.root && review.path === raw.path)
      const kept = (await readRaw()).filter((raw) => !replaced(raw))
      const file: FindingsFile = {
        reviews: [...kept, ...reviews.map((review) => ({ sessionId, ...review }))],
      }
      await Bun.write(path, `${JSON.stringify(file, null, 2)}\n`)
    },
  }
}
