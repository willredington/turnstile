import { join } from 'node:path'
import { STATE_DIR } from '../../core/config.ts'
import type { AnnotationStore } from '../../core/ports.ts'
import type { Annotation } from '../../core/types.ts'

/**
 * Notes on lines, in `.turnstile/annotations.json`.
 *
 * A list rather than a map: notes are ordered, several can sit on one line, and the order
 * they were written in is part of what they say.
 *
 * One flat file, every session's notes together. Every read and every mutation is
 * session-scoped (see `AnnotationStore`), and every write carries every other entry over
 * exactly as stored, unparsed — including notes in the older, run-keyed and chunk-anchored
 * shape, which no session reads any more.
 *
 * Reads degrade to "no notes" — annoying, and visibly so, since the reader can see their own
 * note is missing. Writes throw, because a note that silently fails to save is one the human
 * believes they left.
 */

type AnnotationFile = { annotations: unknown[] }

export function annotationsPath(cwd: string): string {
  return join(cwd, STATE_DIR, 'annotations.json')
}

function isAnnotation(raw: unknown): raw is Annotation {
  if (typeof raw !== 'object' || raw === null) return false
  const record = raw as Partial<Annotation>
  return (
    typeof record.id === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.root === 'string' &&
    typeof record.path === 'string' &&
    typeof record.body === 'string' &&
    typeof record.line === 'number'
  )
}

/** Whether a stored entry is one of `sessionId`'s notes. */
const inSession = (raw: unknown, sessionId: string): raw is Annotation =>
  isAnnotation(raw) && raw.sessionId === sessionId

export function createFileAnnotationStore(cwd: string): AnnotationStore {
  const path = annotationsPath(cwd)

  /** Every stored entry, unparsed, so a write can carry other entries over untouched. */
  const readRaw = async (): Promise<unknown[]> => {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return []
      const raw = (await file.json()) as Partial<AnnotationFile>
      return Array.isArray(raw.annotations) ? raw.annotations : []
    } catch {
      return []
    }
  }

  const write = async (annotations: unknown[]): Promise<void> => {
    const file: AnnotationFile = { annotations }
    await Bun.write(path, `${JSON.stringify(file, null, 2)}\n`)
  }

  return {
    // Entry by entry: one hand-edited note should cost that note, not the file.
    bySession: async (sessionId) =>
      (await readRaw())
        .filter((raw): raw is Annotation => inSession(raw, sessionId))
        .map((annotation) => ({
          ...annotation,
          rangeStart:
            typeof annotation.rangeStart === 'number' ? annotation.rangeStart : annotation.line,
        })),

    add: async (annotation) => {
      await write([...(await readRaw()), annotation])
    },

    remove: async (sessionId, id) => {
      const annotations = await readRaw()
      const kept = annotations.filter((raw) => !(inSession(raw, sessionId) && raw.id === id))
      if (kept.length !== annotations.length) await write(kept)
    },

    markSent: async (sessionId, ids, at) => {
      if (ids.length === 0) return
      const sent = new Set(ids)
      const annotations = await readRaw()

      await write(
        annotations.map((raw) =>
          // Only ever set once: re-sending a note would make the second delivery look like a
          // second complaint about the same line.
          inSession(raw, sessionId) && sent.has(raw.id) && raw.sentAt === null
            ? { ...raw, sentAt: at }
            : raw,
        ),
      )
    },

    markUnsent: async (sessionId, ids) => {
      if (ids.length === 0) return
      const failed = new Set(ids)
      const annotations = await readRaw()

      await write(
        annotations.map((raw) =>
          inSession(raw, sessionId) && failed.has(raw.id) ? { ...raw, sentAt: null } : raw,
        ),
      )
    },
  }
}
