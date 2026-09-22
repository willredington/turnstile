import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repository } from '../../src/core/ports.ts'
import type { RepoStatus } from '../../src/core/types.ts'

/** Git, run synchronously in `cwd` with a fixed identity, failing the test on a non-zero exit. */
export function gitIn(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

/**
 * A fresh, empty git repository in a temp directory — the real-path form, since git reports
 * paths resolved (`/private/var/...` on macOS) and the registry compares them as strings.
 */
export async function tempGitRepo(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  gitIn(dir, 'init', '-q')
  return dir
}

/**
 * A `Repository` for tests that fake the rest of the session too: the project is always a git
 * repository rooted at `root`, and opening a session just remembers its id — no git involved.
 */
export function fakeRepository(root: string, status: RepoStatus = 'git'): Repository {
  let current = status
  const opened = new Set<string>()
  return {
    status: async () => current,
    init: async () => {
      current = 'git'
    },
    open: async (sessionId) => {
      opened.add(sessionId)
      return { root, cwd: root }
    },
    sessionIds: async () => [...opened],
  }
}
