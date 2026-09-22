import type { EditorView } from '@codemirror/view'

/**
 * Where each tab was scrolled to, for as long as the page is open.
 *
 * Both file panes are keyed per tab, so switching rebuilds them from nothing — there is no
 * component left holding the position, which is why this sits at module scope rather than in
 * React state. Nothing else can observe it, and the policy that matters is CodeMirror's.
 *
 * A snapshot is not a pixel offset: `scrollSnapshot()` records the document position of the
 * line at the top of the scroller, plus how far above the fold it sits. That is what makes it
 * survive being handed to a view built fresh over the same file, whose block widgets start at
 * estimated heights and only settle once they have been measured. `ScrollTarget.clip` clamps
 * it to the document, so a file that shrank while the tab was away lands short rather than
 * throwing.
 *
 * Session-only, and not worth persisting: `serveApp` binds an ephemeral port, so the next run
 * is a different origin and would never find what this one stored.
 */
export type ScrollSnapshot = ReturnType<EditorView['scrollSnapshot']>

const remembered = new Map<string, ScrollSnapshot>()

/** Takes a snapshot rather than a view, so this module never touches the DOM. */
export function rememberScroll(key: string, snapshot: ScrollSnapshot): void {
  remembered.set(key, snapshot)
}

/** Undefined for a tab that has never been scrolled, which is what `scrollTo` wants anyway. */
export function recallScroll(key: string): ScrollSnapshot | undefined {
  return remembered.get(key)
}
