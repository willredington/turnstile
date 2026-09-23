import { contentHash } from '../core/annotations.ts'
import { chunkPatch } from '../core/chunking.ts'
import { parsePatch } from '../core/patch.ts'
import type { BaselineResolution, RootHandle, SnapshotStore } from '../core/ports.ts'
import type { Chunk, FileDelta, SnapshotId } from '../core/types.ts'

/**
 * Everything the session has changed since its baseline, as one value.
 *
 * The places that need a base and a next — the board, the background risk pass and the diff
 * pane — all read it from here, so they can never drift onto different trees.
 */

export type Board = {
  root: string
  base: SnapshotId
  next: SnapshotId
  deltas: FileDelta[]
  resolution: BaselineResolution
}

/**
 * The two trees one root's board lies between, and what changed between them.
 *
 * Every difference is on the board, whoever made it and whether or not it was committed:
 * anything in the checkout that differs from where the session started — the agent's edits, a
 * shell command's, or your own — changed during this session.
 */
export async function captureBoardFor(handle: RootHandle): Promise<Board> {
  const next = await handle.snapshots.capture()
  const resolution = await handle.baseline.resolve()
  const deltas = await handle.snapshots.delta(resolution.tree, next)
  return { root: handle.root, base: resolution.tree, next, deltas, resolution }
}

/**
 * One chunk per contiguous region of change, across every file on the board.
 *
 * Separate from `captureBoardFor` because chunking costs a `git diff` per file.
 */
export async function chunksOf(
  root: string,
  snapshots: SnapshotStore,
  base: SnapshotId,
  next: SnapshotId,
  deltas: FileDelta[],
): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  for (const delta of deltas) {
    const patch = await snapshots.patch(base, next, delta.path, delta.previousPath)
    chunks.push(...chunkPatch(parsePatch(patch, delta.path), root))
  }
  return chunks
}

/**
 * Each changed file's `contentHash` at `next` — what decides whether a file's stored review
 * still applies to it.
 */
export async function fileHashes(
  snapshots: SnapshotStore,
  next: SnapshotId,
  deltas: readonly FileDelta[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  for (const delta of deltas) {
    const content = delta.status === 'Dropped' ? null : await snapshots.contents(next, delta.path)
    hashes.set(delta.path, contentHash(content))
  }
  return hashes
}
