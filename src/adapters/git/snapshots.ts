import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotStore } from '../../core/ports.ts'
import type { FileDelta, SnapshotId } from '../../core/types.ts'
import { git, gitOrThrow } from './commands.ts'
import { computeDelta, patchFor } from './delta.ts'

/**
 * A SnapshotStore over git objects.
 *
 * The whole promise of this adapter is that capturing a snapshot leaves the user's git
 * state untouched — index, HEAD, stash, reflog, history. Plumbing plus a scratch
 * GIT_INDEX_FILE is the only way to get that guarantee; `git stash` and `git commit` all
 * fail it.
 *
 * It keeps no checkpoint. Review state is per change and lives in the ledger; the baseline is
 * the tree a run recorded when it opened. What is left here writes nothing but objects.
 */

/** The empty tree is a well-known constant; git can always resolve it. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export type GitSnapshotOptions = {
  cwd: string
  /** Path prefixes stripped from every delta, e.g. Turnstile's own state directory. */
  excludePrefixes: string[]
  /**
   * Gitignore-style patterns for untracked files a capture should never pick up, on top of the
   * repository's own ignore rules — build output (`target/`, `node_modules/`) that an agent
   * produces before anyone has written a `.gitignore` for it. Tracked files are unaffected.
   */
  untrackedExcludes: string[]
}

/** Absolute path to $GIT_DIR. In a linked worktree this is that worktree's own directory
 *  (`.git/worktrees/<name>`), so everything kept under it is per-worktree. */
async function gitDir(cwd: string): Promise<string> {
  return await gitOrThrow(cwd, ['rev-parse', '--absolute-git-dir'])
}

/**
 * A scratch index, unique to this capture.
 *
 * Living under $GIT_DIR keeps it out of the worktree, so it can never itself show up as an
 * untracked file in a snapshot.
 *
 * Unique per call because git takes an exclusive `index.lock` around `write-tree`, and the
 * board refresh, the background precompute pass and the gate all capture concurrently —
 * two captures sharing a path collide, and the collision surfaced once as a gate that failed
 * and a turn that finished with nothing reviewed.
 */
async function scratchIndexPath(cwd: string): Promise<string> {
  const dir = join(await gitDir(cwd), 'turnstile')
  await mkdir(dir, { recursive: true })
  return join(dir, `index-${process.pid}-${randomUUID()}`)
}

/** Where git reads the user's global excludes from when `core.excludesFile` is unset. */
function defaultGlobalExcludesPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config'), 'git', 'ignore')
}

/**
 * Write the excludes file a capture passes as `core.excludesFile`: the user's own global
 * excludes, followed by `patterns`.
 *
 * Overriding `core.excludesFile` replaces the user's global file rather than adding to it, so
 * its contents are copied in first — otherwise a capture would suddenly pick up files the
 * user's own git never shows them.
 */
export async function writeExcludesFile(cwd: string, patterns: string[]): Promise<string> {
  const configured = await git(cwd, ['config', '--path', '--get', 'core.excludesFile'])
  const globalPath =
    configured.exitCode === 0 && configured.stdout.trim() !== ''
      ? configured.stdout.trim()
      : defaultGlobalExcludesPath()
  const global = await readFile(globalPath, 'utf8').catch(() => '')

  const dir = join(await gitDir(cwd), 'turnstile')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'excludes')
  const separator = global === '' || global.endsWith('\n') ? '' : '\n'
  await writeFile(path, `${global}${separator}${patterns.join('\n')}\n`)
  return path
}

/**
 * Stage the entire worktree into a scratch index and write it out as a tree.
 *
 * `read-tree HEAD` seeds the index so `add -A` records deletions relative to HEAD rather
 * than treating a fresh empty index as "everything is new". `add -A` honours .gitignore
 * and picks up untracked-but-not-ignored files, which is the set a reviewer cares about.
 *
 * No pathspec: excluding Turnstile's own directory here would hard-error once the user
 * gitignores it, and would report a committed .turnstile/config.json as deleted against the
 * HEAD baseline. That filtering happens on the delta instead, where both sides match.
 */
export async function captureTree(
  cwd: string,
  excludesFile: string | null = null,
): Promise<SnapshotId> {
  const indexFile = await scratchIndexPath(cwd)
  const env = { GIT_INDEX_FILE: indexFile }
  const config = excludesFile === null ? [] : ['-c', `core.excludesFile=${excludesFile}`]

  try {
    // An unborn HEAD (fresh repo, no commits) has no tree to read.
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    await gitOrThrow(
      cwd,
      head.exitCode === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'],
      env,
    )

    await gitOrThrow(cwd, [...config, 'add', '-A'], env)
    return await gitOrThrow(cwd, ['write-tree'], env)
  } finally {
    // The tree is in the object database now; the index was only ever scaffolding, and a
    // per-call name means these would otherwise pile up forever.
    await rm(indexFile, { force: true }).catch(() => {})
    await rm(`${indexFile}.lock`, { force: true }).catch(() => {})
  }
}

/** The tree at the current branch head, or the empty tree in a repo with no commits. */
export async function headTree(cwd: string): Promise<SnapshotId> {
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
  return head.exitCode === 0 ? head.stdout.trim() : EMPTY_TREE
}

export function createGitSnapshotStore(options: GitSnapshotOptions): SnapshotStore {
  const { cwd, excludePrefixes, untrackedExcludes } = options

  // Written once per store, on first capture. Nothing to write when there is nothing to add.
  let excludesFile: Promise<string | null> | null = null
  const excludes = (): Promise<string | null> => {
    if (untrackedExcludes.length === 0) return Promise.resolve(null)
    excludesFile ??= writeExcludesFile(cwd, untrackedExcludes).catch(() => {
      excludesFile = null
      return null
    })
    return excludesFile
  }

  return {
    capture: async () => captureTree(cwd, await excludes()),
    delta: (base, next): Promise<FileDelta[]> => computeDelta(cwd, base, next, excludePrefixes),
    patch: (base, next, path, previousPath) => patchFor(cwd, base, next, path, previousPath),
    contents: async (snapshot, path) => {
      // Deliberately not gitOrThrow: a missing path is the normal answer for a created or
      // deleted file, not a failure. And deliberately untrimmed — see the port.
      const result = await git(cwd, ['show', `${snapshot}:${path}`])
      return result.exitCode === 0 ? result.stdout : null
    },
  }
}
