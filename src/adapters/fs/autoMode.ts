import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePolicy } from '../../core/autoMode.ts'
import { STATE_DIR } from '../../core/config.ts'
import type { AutoModeStore } from '../../core/ports.ts'

/**
 * The auto-mode policy, in `~/.turnstile/auto-mode.json`.
 *
 * Per user, not per repository: what a person would rather be asked about follows them, and
 * setting it up once is the point. `~/.turnstile` is one of the directories the agent is kept
 * out of (`protectedDirs` in `cli/app.ts`), so the agent cannot rewrite the rules it is judged by.
 *
 * A file that is missing or not a policy reads as none, which means auto-mode is off and every
 * call prompts — the safe direction to be wrong in. Written through a temporary file and a
 * rename, so a crash mid-write cannot leave half a policy behind.
 */

export function autoModePath(home: string): string {
  return join(home, STATE_DIR, 'auto-mode.json')
}

export function createFileAutoModeStore(home: string): AutoModeStore {
  const path = autoModePath(home)

  return {
    load: async () => {
      try {
        const file = Bun.file(path)
        if (!(await file.exists())) return null
        return parsePolicy(await file.json())
      } catch {
        return null
      }
    },

    save: async (policy) => {
      const temporary = `${path}.${process.pid}.tmp`
      await Bun.write(temporary, `${JSON.stringify(policy, null, 2)}\n`)
      await rename(temporary, path)
    },
  }
}
