import { sep } from 'node:path'
import type { RootHandle, RootRegistry } from '../../core/ports.ts'
import { createGitBaseline } from './baseline.ts'
import { createGitSnapshotStore } from './snapshots.ts'

/**
 * A `RootRegistry` holding exactly one root: the repository the live session works in.
 *
 * Nothing is discovered. `session.ts` activates it when a session opens, and a path
 * outside it simply has no root — the write path refuses it rather than starting to track
 * somewhere new.
 */
export type GitRootRegistryOptions = {
  excludePrefixes: string[]
  untrackedExcludes: string[]
}

export function createGitRootRegistry(options: GitRootRegistryOptions): RootRegistry {
  let active: RootHandle | null = null
  let activeSession: string | null = null

  return {
    knownRoots: () => (active === null ? [] : [active]),

    activate(root, sessionId) {
      // The session matters as well as the root: the handle's baseline is that session's.
      if (active?.root === root && activeSession === sessionId) return active
      activeSession = sessionId
      active = {
        root,
        snapshots: createGitSnapshotStore({
          cwd: root,
          excludePrefixes: options.excludePrefixes,
          untrackedExcludes: options.untrackedExcludes,
        }),
        baseline: createGitBaseline({ cwd: root, sessionId }),
      }
      return active
    },

    deactivate() {
      active = null
      activeSession = null
    },

    rootFor(absolutePath) {
      if (active === null) return null
      const inside = absolutePath === active.root || absolutePath.startsWith(`${active.root}${sep}`)
      return inside ? active : null
    },

    async teardown() {
      active = null
    },
  }
}
