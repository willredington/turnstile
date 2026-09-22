import { parseHunks } from '../../core/patch.ts'
import type { FileDelta, LifecycleStatus } from '../../core/types.ts'
import { git } from './commands.ts'

/**
 * Beyond this many bytes of patch text for one file, we stop parsing line content and
 * mark the file oversized. The gate still fires — a huge diff is the *last* thing to
 * wave through — but we don't hold megabytes of patch in memory to classify it.
 */
const MAX_PATCH_BYTES = 512 * 1024

/** Similarity index at which `git diff -M` calls a rename exact. */
const EXACT_RENAME = 'R100'

function statusFor(code: string): LifecycleStatus {
  const letter = code[0]
  if (letter === 'A') return 'Created'
  if (letter === 'D') return 'Dropped'
  // R (rename), C (copy), M (modify), T (typechange) all land here: the file exists on
  // both sides, so from a reviewer's standpoint it was modified.
  return 'Modified'
}

/** The mode git records a submodule or nested repository under — a commit, not a file. */
const GITLINK_MODE = '160000'

type RawEntry = { code: string; path: string; previousPath?: string; gitlink: boolean }

/**
 * `--raw -z` emits a NUL-terminated header per entry — `:oldmode newmode oldsha newsha status`
 * — followed by one path, or two for a rename or copy (source, then destination).
 *
 * Raw rather than `--name-status` for the modes: a directory that has its own `.git` is staged
 * as a gitlink, and its "change" is a commit id moving, not anything a reviewer can read.
 */
function parseRaw(raw: string): RawEntry[] {
  const fields = raw.split('\0')
  const entries: RawEntry[] = []

  let i = 0
  while (i < fields.length) {
    const header = fields[i]
    if (header === undefined || !header.startsWith(':')) break
    const [oldMode, newMode, , , code] = header.slice(1).split(' ')
    if (code === undefined) break
    const gitlink = oldMode === GITLINK_MODE || newMode === GITLINK_MODE
    const isPaired = code.startsWith('R') || code.startsWith('C')

    if (isPaired) {
      const previousPath = fields[i + 1]
      const path = fields[i + 2]
      if (previousPath === undefined || path === undefined) break
      entries.push({ code, path, previousPath, gitlink })
      i += 3
    } else {
      const path = fields[i + 1]
      if (path === undefined) break
      entries.push({ code, path, gitlink })
      i += 2
    }
  }
  return entries
}

/**
 * The delta of the working tree against the board's baseline.
 *
 * `excludePrefixes` is injected rather than hardcoded: this adapter has no business
 * knowing where Turnstile keeps its own state. Filtering happens HERE rather than at snapshot
 * time so both sides of the diff are built identically — excluding a path from the
 * snapshot alone would report a committed file under that path as deleted.
 * Both sides are trees, so this is a pure object-database comparison — it never
 * consults the index or the worktree, and so can never be perturbed by them.
 */
export async function computeDelta(
  cwd: string,
  baseTree: string,
  newTree: string,
  excludePrefixes: string[] = [],
): Promise<FileDelta[]> {
  const listing = await git(cwd, ['diff', '--raw', '-M', '-z', baseTree, newTree])
  if (listing.exitCode !== 0) {
    throw new Error(`git diff --raw failed: ${listing.stderr.trim()}`)
  }

  const excluded = (path: string): boolean =>
    excludePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

  // A nested repository is its own project with its own history; its gitlink entry says only
  // that some commit id moved, which is nothing a reviewer can act on.
  const entries = parseRaw(listing.stdout).filter(
    (entry) => !entry.gitlink && !excluded(entry.path) && !excluded(entry.previousPath ?? ''),
  )
  const deltas: FileDelta[] = []

  for (const entry of entries) {
    const status = statusFor(entry.code)
    const pathsToDiff =
      entry.previousPath === undefined ? [entry.path] : [entry.previousPath, entry.path]

    const patchResult = await git(cwd, [
      'diff',
      '-M',
      '-U3',
      baseTree,
      newTree,
      '--',
      ...pathsToDiff,
    ])
    const patch = patchResult.stdout

    if (patch.length > MAX_PATCH_BYTES) {
      deltas.push({
        path: entry.path,
        ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
        status,
        pureRename: false,
        binary: false,
        hunks: [],
        addedLines: [],
        removedLines: [],
      })
      continue
    }

    const parsed = parseHunks(patch)
    deltas.push({
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status,
      pureRename: entry.code === EXACT_RENAME,
      binary: parsed.binary,
      hunks: parsed.hunks,
      addedLines: parsed.addedLines,
      removedLines: parsed.removedLines,
    })
  }

  return deltas
}

/**
 * Patch text for one file, fetched on demand by the adjudication page. The payload
 * deliberately carries only diff *locations* (spec §4) — git already holds the code,
 * and duplicating it into the payload makes it large and stale.
 */
export async function patchFor(
  cwd: string,
  baseTree: string,
  newTree: string,
  path: string,
  previousPath?: string,
): Promise<string> {
  const paths = previousPath === undefined ? [path] : [previousPath, path]
  const result = await git(cwd, ['diff', '-M', '-U3', baseTree, newTree, '--', ...paths])
  if (result.exitCode !== 0) return `(diff unavailable: ${result.stderr.trim()})`
  if (result.stdout.length > MAX_PATCH_BYTES) {
    return `(diff too large to render: ${result.stdout.length} bytes)`
  }
  return result.stdout
}
