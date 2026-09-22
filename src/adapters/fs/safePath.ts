import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/**
 * Resolves `path` against `root`, refusing anything that would land outside it.
 *
 * Shared by every adapter that turns a browser-supplied path into a real one on disk — a
 * review tool that can be talked into touching a file outside the repository it is
 * reviewing is a worse problem than any it solves.
 *
 * The check works by joining the path first to normalize `.` and `..`, then verifying the
 * result stays within root. This catches traversal attempts *in the path string itself*
 * after normalization — but it is a lexical check: if some path segment inside `root` is
 * itself a symlink pointing outside it, the joined path still lexically starts with `root`
 * even though the file it names does not. `readInside` closes that gap with a `realpath`
 * check after this one; a caller that only needs the lexical guard (no filesystem access,
 * e.g. validating a path before it exists) can still use this function alone.
 */
export function resolveInside(root: string, path: string): string | null {
  if (isAbsolute(path) || path.includes('\0')) return null

  const full = join(root, path)
  return full === root || full.startsWith(`${root}/`) ? full : null
}

/**
 * Reads `path` (resolved safely against `root`) as UTF-8 text.
 *
 * Null covers four different situations alike on purpose — missing, unreadable, outside
 * `root` lexically, or outside `root` once symlinks are resolved — because none of them is
 * something a caller can do anything about beyond showing "not found".
 *
 * After `resolveInside`'s lexical check passes, this also resolves the *real* path
 * (following any symlinks in it) and re-checks that it, too, stays within `root` — the same
 * join-then-prefix-check shape, applied to the resolved path. Without this, a symlink living
 * inside `root` but pointing outside it would lexically pass `resolveInside` and let this
 * function read arbitrary files elsewhere on disk.
 */
export async function readInside(root: string, path: string): Promise<string | null> {
  return readGuarded(root, path, (file) => file.text())
}

/**
 * The same guarantees as `readInside`, but handing back the raw bytes.
 *
 * Bytes rather than text because some decisions can only be made before decoding: whether a
 * file is binary at all (`core/binary.ts` looks for a NUL byte, which UTF-8 decoding would
 * have turned into an indistinguishable code point) is the one this exists for.
 */
export async function readBytesInside(root: string, path: string): Promise<Uint8Array | null> {
  return readGuarded(root, path, (file) => file.bytes())
}

/**
 * The traversal guard both readers share: resolve `path` inside `root`, refuse anything that
 * escapes it lexically or through a symlink, then read whatever shape the caller asked for.
 */
async function readGuarded<T>(
  root: string,
  path: string,
  read: (file: ReturnType<typeof Bun.file>) => Promise<T>,
): Promise<T | null> {
  const full = resolveInside(root, path)
  if (full === null) return null

  // `root` itself may be reached through a symlink — e.g. on macOS a temp dir's path
  // lexically starts with `/var` but really lives under `/private/var` — so the real-path
  // check below has to compare against `root`'s own real path, not the lexical one, or every
  // ordinary file under a symlinked root would be rejected as "outside".
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    // `root` not existing is not this function's problem to report; let the read below fail
    // in its own way instead of treating a bad root as a security refusal.
    realRoot = root
  }

  let real: string
  try {
    real = await realpath(full)
  } catch {
    // Missing file (or a broken symlink, or any other realpath failure): fall through to the
    // same "not found" a plain missing file gets below, rather than treating this as a
    // security refusal.
    real = full
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}/`)) return null

  try {
    const file = Bun.file(full)
    return (await file.exists()) ? await read(file) : null
  } catch {
    return null
  }
}
