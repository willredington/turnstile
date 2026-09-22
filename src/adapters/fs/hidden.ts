import { join } from 'node:path'
import { STATE_DIR } from '../../core/config.ts'
import type { HiddenFileStore } from '../../core/ports.ts'
import type { HiddenFile } from '../../core/types.ts'

/**
 * Hidden changed files, in `.turnstile/hidden.json`.
 *
 * One flat file, every session's entries together, the same way notes are kept: every read and
 * mutation is session-scoped, and every write carries every other entry over exactly as stored.
 *
 * Reads degrade to "nothing hidden" — the worst that costs is a file showing that the reader had
 * put away. Writes throw, so a hide that failed to save is not mistaken for one that worked.
 */

type HiddenFileFile = { hidden: unknown[] }

export function hiddenPath(cwd: string): string {
  return join(cwd, STATE_DIR, 'hidden.json')
}

function isHiddenFile(raw: unknown): raw is HiddenFile {
  if (typeof raw !== 'object' || raw === null) return false
  const record = raw as Partial<HiddenFile>
  return (
    typeof record.sessionId === 'string' &&
    typeof record.root === 'string' &&
    typeof record.path === 'string' &&
    typeof record.fileHash === 'string'
  )
}

const isEntry = (raw: unknown, sessionId: string, root: string, path: string): boolean =>
  isHiddenFile(raw) && raw.sessionId === sessionId && raw.root === root && raw.path === path

export function createFileHiddenStore(cwd: string): HiddenFileStore {
  const path = hiddenPath(cwd)

  const readRaw = async (): Promise<unknown[]> => {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return []
      const raw = (await file.json()) as Partial<HiddenFileFile>
      return Array.isArray(raw.hidden) ? raw.hidden : []
    } catch {
      return []
    }
  }

  const write = async (hidden: unknown[]): Promise<void> => {
    const file: HiddenFileFile = { hidden }
    await Bun.write(path, `${JSON.stringify(file, null, 2)}\n`)
  }

  return {
    bySession: async (sessionId) =>
      (await readRaw()).filter(
        (raw): raw is HiddenFile => isHiddenFile(raw) && raw.sessionId === sessionId,
      ),

    hide: async (entry) => {
      const kept = (await readRaw()).filter(
        (raw) => !isEntry(raw, entry.sessionId, entry.root, entry.path),
      )
      await write([...kept, entry])
    },

    show: async (sessionId, root, file) => {
      const hidden = await readRaw()
      const kept = hidden.filter((raw) => !isEntry(raw, sessionId, root, file))
      if (kept.length !== hidden.length) await write(kept)
    },
  }
}
