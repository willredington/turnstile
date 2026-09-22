import { useEffect, useMemo, useState } from 'react'
import { tabKey } from '../../../core/tabs.ts'
import type { DiffView } from '../../../core/types.ts'
import { PlainCode } from './editor/PlainCode.tsx'
import { useAsk } from './editor/useAsk.ts'
import { type FileNotes, MARKUP_HINT, NoteCount, SendNotes } from './FileView.tsx'

/**
 * A file with nothing on the board — opened from the project tree for context,
 * not for a decision. Whatever this branch actually changed elsewhere in the file (there can
 * be none) is highlighted, but there is no gate here, because there is nothing to gate.
 *
 * Editable, and open to notes and questions, on the same terms as the board's own document
 * view, so neither "make an edit" nor "tell the agent about this" quietly means "only on files
 * the agent already touched". Read-only and note-less until a session has opened, since before
 * that there is no root to write into and no session to keep a note in.
 *
 * Nothing here closes it: its tab owns that, the same as every other tab.
 *
 * This used to window the file by hand and tokenize it with Shiki off the main thread, because
 * neither scaled: a 4,510-line file built ~117,000 DOM nodes, cost seconds of React render and
 * layout, and had to defer highlighting by a task just so the loading state could be seen.
 * CodeMirror windows the document itself and parses incrementally, so all of that is gone —
 * along with the line-height constant the row arithmetic depended on.
 */
export function ContextFileView({
  path,
  diff,
  notes,
  unsentTotal,
  onSendNotes,
  onSave,
}: {
  path: string
  diff: DiffView | null
  /** This file's notes. Absent until a session has opened — see `onSave`. */
  notes?: FileNotes
  /** Unsent notes across every file — what "Send notes" would hand over. */
  unsentTotal: number
  onSendNotes: () => void
  /** Save the reader's own edit. Absent until a session has opened, since there is no root to
   *  write into before then. */
  onSave?: (text: string) => Promise<void>
}) {
  /** What the file turned out to hold. Binary is its own answer, not an error and not empty
   *  text: the file is fine, it just has no lines to render. */
  type Contents = { kind: 'text'; text: string } | { kind: 'binary' }

  const [contents, setContents] = useState<Contents | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Questions about a file nobody changed.
   *
   * This is the half of "ask about any file" that only exists here: there is no review on an
   * unchanged file to read, so a question is often the only way to find out what it does.
   * The root is null — this tab is keyed by path alone, and `/ask` resolves it the same way
   * `/files/content` already does for the very same file.
   */
  const asking = useAsk(tabKey(null, path), null, path)

  useEffect(() => {
    let live = true
    setContents(null)
    setError(null)
    void fetch(`/files/content?path=${encodeURIComponent(path)}`)
      .then((response) => {
        if (!response.ok) throw new Error('not found')
        return response.json() as Promise<{ text?: string; binary?: boolean }>
      })
      .then((body) => {
        if (!live) return
        setContents(
          body.binary === true ? { kind: 'binary' } : { kind: 'text', text: body.text ?? '' },
        )
      })
      .catch(() => {
        if (live) setError('Could not read this file — it may no longer exist.')
      })
    return () => {
      live = false
    }
  }, [path])

  const text = contents?.kind === 'text' ? contents.text : null

  const file = diff?.files.find((candidate) => candidate.path === path) ?? null
  // Lines the branch actually changed, in new-file coordinates — the only ones a plain-text
  // preview of the current file can meaningfully highlight (an old-side removal has no line
  // in the file as it stands now).
  const changedLines = useMemo(() => {
    const lines = new Set<number>()
    if (file === null) return lines
    for (const hunk of file.patch.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add' && line.newLine !== null) lines.add(line.newLine)
      }
    }
    return lines
  }, [file])

  const slash = path.lastIndexOf('/')

  return (
    <div className="file-pane">
      <header className="file-pane-head">
        <div className="file-pane-title">
          <h2>
            <span className="file-pane-dir">{path.slice(0, slash + 1)}</span>
            <span className="file-pane-name">{path.slice(slash + 1)}</span>
          </h2>
          <span className="file-pane-facts">
            {contents?.kind === 'binary'
              ? 'unchanged · binary'
              : `unchanged · ${text === null || text === '' ? 0 : text.split('\n').length} lines`}
          </span>
        </div>
        {contents?.kind === 'text' && (
          <div className="file-pane-actions">
            {notes !== undefined && <NoteCount annotations={notes.annotations} />}
            <button
              type="button"
              className="btn btn-secondary"
              title="Ask about this file as a whole. Answered now, and nothing is changed."
              onClick={() => asking.open(null, '')}
            >
              Ask about this file
            </button>
            {notes !== undefined && (
              <SendNotes
                annotations={notes.annotations}
                unsentTotal={unsentTotal}
                onSend={onSendNotes}
              />
            )}
          </div>
        )}
      </header>

      {error !== null ? (
        <p className="placeholder">{error}</p>
      ) : contents?.kind === 'binary' ? (
        <p className="placeholder">This is a binary file — there are no lines to show.</p>
      ) : text === null ? (
        <p className="diff-note">Reading the file…</p>
      ) : (
        <div className="file-pane-body context-file-body">
          <PlainCode
            path={path}
            text={text}
            changedLines={changedLines}
            scrollKey={tabKey(null, path)}
            asking={asking}
            notes={notes}
            onSave={onSave}
          />
        </div>
      )}

      {contents?.kind === 'text' && (
        <footer className="file-pane-foot">
          <span>
            {notes === undefined
              ? 'Highlight code or drag the line numbers to ask about it. Notes open with the session.'
              : MARKUP_HINT}
          </span>
        </footer>
      )}
    </div>
  )
}
