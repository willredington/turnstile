import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from '../../core/config.ts'
import type { OpenedSession, Repository } from '../../core/ports.ts'
import type { RepoStatus } from '../../core/types.ts'
import { BASELINE_REF_PREFIX, baselineRef } from './baseline.ts'
import { git, gitOrThrow } from './commands.ts'
import { captureTree, writeExcludesFile } from './snapshots.ts'

/**
 * The repository Turnstile was launched in, and each session's baseline within it.
 *
 * Every session works directly in the user's checkout. What makes a session a session is the
 * tree its checkout stood at when it started, recorded as `refs/turnstile/baselines/<sessionId>`
 * (see `baseline.ts`) — uncommitted and untracked work included, so the board only ever shows
 * what changed after that point.
 *
 * Nothing here is persisted by Turnstile: the baseline refs are the record of which sessions
 * exist.
 */

export type GitRepositoryOptions = {
  /** The directory Turnstile was launched in. May be a subdirectory of the repository. */
  dir: string
  /** Applied to `init`'s initial commit and to each baseline, so neither sweeps in build
   *  output. */
  untrackedExcludes: string[]
}

/** Used only when the user has no git identity configured, so `init` can still commit — and
 *  always for a baseline commit, which is Turnstile's bookkeeping, not anyone's work. */
const FALLBACK_IDENTITY = ['-c', 'user.name=Turnstile', '-c', 'user.email=turnstile@localhost']

export function createGitRepository(options: GitRepositoryOptions): Repository {
  const { dir, untrackedExcludes } = options

  /**
   * Keep `.turnstile/` out of the user's own `git status` — it holds notes and the analysis
   * cache, which are nobody's work.
   *
   * Written to `info/exclude` rather than `.gitignore`: that file is local to this clone and is
   * never itself a change anyone has to commit.
   */
  async function excludeStateDir(): Promise<void> {
    const common = await gitOrThrow(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const path = join(common, 'info', 'exclude')
    const existing = await readFile(path, 'utf8').catch(() => '')
    const listed = existing
      .split('\n')
      .some((line) => [STATE_DIR, `${STATE_DIR}/`, `/${STATE_DIR}/`].includes(line.trim()))
    if (listed) return

    await mkdir(dirname(path), { recursive: true })
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(path, `${separator}${STATE_DIR}/\n`)
  }

  /**
   * Record the checkout's tree as it stands — before the agent has done anything — as
   * `sessionId`'s baseline. Wrapped in a commit so the ref points at something git's garbage
   * collection keeps alive; the commit is on no branch, so it is never anyone's history. With
   * no HEAD yet (a repository with no commits), it has no parent.
   */
  async function recordBaseline(top: string, sessionId: string): Promise<void> {
    const excludes =
      untrackedExcludes.length === 0 ? null : await writeExcludesFile(top, untrackedExcludes)
    const tree = await captureTree(top, excludes)
    const head = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const parent = head.exitCode === 0 ? ['-p', head.stdout.trim()] : []
    const commit = await gitOrThrow(top, [
      ...FALLBACK_IDENTITY,
      'commit-tree',
      tree,
      ...parent,
      '-m',
      `Turnstile baseline for session ${sessionId}`,
    ])
    await gitOrThrow(top, ['update-ref', baselineRef(sessionId), commit])
  }

  return {
    async status(): Promise<RepoStatus> {
      return (await git(dir, ['rev-parse', '--show-toplevel'])).exitCode === 0 ? 'git' : 'not-git'
    },

    async init(): Promise<void> {
      if ((await git(dir, ['rev-parse', '--show-toplevel'])).exitCode !== 0) {
        await gitOrThrow(dir, ['init', '-q'])
      }
      if ((await git(dir, ['rev-parse', '--verify', 'HEAD'])).exitCode === 0) return

      await excludeStateDir()
      const excludes = await writeExcludesFile(dir, untrackedExcludes)
      await gitOrThrow(dir, ['-c', `core.excludesFile=${excludes}`, 'add', '-A'])

      const commit = ['commit', '-q', '--allow-empty', '-m', 'Initial commit']
      if ((await git(dir, commit)).exitCode !== 0) {
        await gitOrThrow(dir, [...FALLBACK_IDENTITY, ...commit])
      }
    },

    async open(sessionId: string): Promise<OpenedSession> {
      const top = await realpath(await gitOrThrow(dir, ['rev-parse', '--show-toplevel']))
      const cwd = await realpath(dir)
      await excludeStateDir()

      // Only the first time: a resumed session is measured from where it originally started.
      const recorded =
        (await git(top, ['rev-parse', '--verify', '--quiet', baselineRef(sessionId)])).exitCode ===
        0
      if (!recorded) await recordBaseline(top, sessionId)

      return { root: top, cwd }
    },

    async sessionIds(): Promise<string[]> {
      const refs = await gitOrThrow(dir, [
        'for-each-ref',
        '--format=%(refname)',
        BASELINE_REF_PREFIX,
      ])
      return refs
        .split('\n')
        .filter((ref) => ref.startsWith(BASELINE_REF_PREFIX))
        .map((ref) => ref.slice(BASELINE_REF_PREFIX.length))
    },
  }
}
