import type { EditTarget } from '../../core/ports.ts'
import { readInside, resolveInside } from './safePath.ts'

/**
 * Reading and writing files across every root the session knows about.
 *
 * No bound `cwd`: paths arrive from the browser or the write tool tagged with which root they
 * belong to, resolved against that root and checked to still be inside it per call — see
 * `safePath.ts` for the guard both this and `projectTree.ts` share.
 */
export function createFileEditTarget(): EditTarget {
  return {
    read: (root, path) => readInside(root, path),

    write: async (root, path, text) => {
      const full = resolveInside(root, path)
      if (full === null) throw new Error(`refusing to write outside the root: ${root}/${path}`)

      await Bun.write(full, text)
    },
  }
}
