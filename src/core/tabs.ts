/**
 * The tab strip's bookkeeping.
 *
 * One row, holding every file the reader has open — pulled up from the project tree, or clicked
 * in the review rail — in the order it was opened. The rail is not a second row of tabs: it is
 * the board, saying what the agent changed and what the review made of it, and clicking a row
 * there opens a tab like anything else does.
 *
 * It was two rows until this: the rail stood in for the board's own tabs, and this row held only
 * files the agent had never touched, `stillOpen` filtering out the rest so that no file was ever
 * in both places at once. The cost was that a file you were reading lost its tab the moment the
 * agent touched it, and a file opened from the rail never had one at all.
 *
 * Lives in `core` for the same reason `filetree.ts` does: it is pure, and `adapters/web/ui`
 * has no way to test a React component.
 */

/**
 * Where to move when a tab goes away: the next one along, or the one before it when the tab
 * that went was last. Null when nothing is left, or when the tab was not in the list.
 *
 * What every tab strip does: here, which tab takes the screen when the open one is closed.
 */
export function neighbourOf<T>(list: readonly T[], index: number): T | null {
  if (index < 0) return null
  return list[index + 1] ?? list[index - 1] ?? null
}

/**
 * Opens `path`, unless it is already a tab. Re-opening a file that is on screen must not
 * duplicate it or shuffle the strip out from under the cursor — clicking it again just means
 * "show me that one".
 */
export function openFile(open: readonly string[], path: string): string[] {
  return open.includes(path) ? [...open] : [...open, path]
}

/**
 * One tab's identity.
 *
 * The board keys on root *and* path, because the same path under two roots is two files. The
 * tab strip has no root and keys on the path alone. A path can never contain a NUL — `safePath`
 * rejects one — so the two shapes cannot collide.
 *
 * The same string the React `key` uses, deliberately: anything that remembers where a tab was
 * has to agree with what counts as the same tab.
 */
export function tabKey(root: string | null, path: string): string {
  return root === null ? path : `${root}\0${path}`
}
