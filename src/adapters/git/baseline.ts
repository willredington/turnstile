import type { Baseline, BaselineResolution } from '../../core/ports.ts'
import { git } from './commands.ts'
import { EMPTY_TREE, headTree } from './snapshots.ts'

/**
 * Where the board starts.
 *
 * Everything Turnstile shows is the difference between this tree and the working tree, so what
 * this returns defines what "the session's changes" means: everything in the checkout that
 * differs from where the session started, committed or not, whoever made it.
 *
 * The starting point is recorded in git at the session's first prompt (`Repository.open`), as
 * `refs/turnstile/baselines/<sessionId>`, so it survives restarts and resumes without Turnstile
 * persisting anything of its own. Comparing trees rather than commits is what keeps an agent's
 * own commit from moving the baseline over the work it made.
 */

/** Where every session's starting tree is recorded, one ref per session. */
export const BASELINE_REF_PREFIX = 'refs/turnstile/baselines/'

/** Where a session's starting tree is recorded — see `Repository.open`. */
export function baselineRef(sessionId: string): string {
  return `${BASELINE_REF_PREFIX}${sessionId}`
}

/** The current branch name, or null on detached HEAD or when it cannot be resolved. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (result.exitCode !== 0) return null
  const name = result.stdout.trim()
  return name === '' || name === 'HEAD' ? null : name
}

export type GitBaselineOptions = {
  /** The repository's top level. */
  cwd: string
  sessionId: string
}

/** The tree `rev`'s object resolves to, or null when git does not know it. */
async function treeOf(cwd: string, rev: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * Resolution order: the session's recorded starting tree, then HEAD's tree, then the empty
 * tree — so a fresh repository with no commits still boards.
 */
export function createGitBaseline(options: GitBaselineOptions): Baseline {
  const { cwd, sessionId } = options

  return {
    async resolve(): Promise<BaselineResolution> {
      const current = await currentBranch(cwd)

      const recorded = await treeOf(cwd, baselineRef(sessionId))
      if (recorded !== null) return { tree: recorded, source: 'session-start', branch: current }

      const head = await headTree(cwd)
      return { tree: head, source: head === EMPTY_TREE ? 'empty' : 'head', branch: current }
    },
  }
}
