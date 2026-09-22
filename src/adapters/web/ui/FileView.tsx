import { useEffect, useRef, useState } from 'react'
import type { DocumentRegion } from '../../../core/documentPlan.ts'
import { riskLabel } from '../../../core/risk.ts'
import { tabKey } from '../../../core/tabs.ts'
import type { Annotation, DiffView, LiveChunk, RiskLevel } from '../../../core/types.ts'
import type { ChangedFile } from './ChangedFiles.tsx'
import { CodeDocument } from './editor/CodeDocument.tsx'
import { type BandInfo, FindingList } from './editor/parts.tsx'
import { useAsk } from './editor/useAsk.ts'

/** A file's notes, plus a way to leave or withdraw one. */
export type FileNotes = {
  annotations: Annotation[]
  onAdd: (
    rangeStart: number,
    line: number,
    side: 'old' | 'new',
    lineText: string,
    body: string,
  ) => void
  onRemove: (id: string) => void
}

/**
 * One changed file, as the document it is: the whole file top to bottom, its changes against
 * the session's baseline marked where they fall, each introduced by a card saying what the
 * review found in it. Every line is a note target, changed or not, because the note worth
 * writing is so often about the line the agent *didn't* touch.
 *
 * Nothing here decides anything. Notes stay with the session until they are sent.
 */
export function FileView({
  file,
  diff,
  notes,
  unsentTotal,
  diffRevision,
  baselineLabel,
  onSendNotes,
  reviewed,
  onHide,
  onShow,
  onSave,
}: {
  file: ChangedFile
  diff: DiffView | null
  notes: FileNotes
  /** Unsent notes across every file — what "Send notes" would hand over. */
  unsentTotal: number
  /** Moves whenever the tree may have — what the file on disk is re-read on. */
  diffRevision: number
  /** What the changes are measured from, for the footer ("since this session started"). */
  baselineLabel: string | null
  onSendNotes: () => void
  /** Whether this file is already marked reviewed — it can be read without that changing. */
  reviewed: boolean
  /** Done with this file: hide it until it changes again. */
  onHide: () => void
  /** Not reviewed after all: put it back in the list. */
  onShow: () => void
  /** Write the reader's own edit of this file. */
  onSave: (text: string) => Promise<void>
}) {
  const { root, path } = file
  const scrollKey = tabKey(root, path)
  // Owned here rather than inside the document, so the header's "Ask about this file" and
  // the cards set into the code are looking at the same threads.
  const asking = useAsk(scrollKey, root, path)
  const patch =
    diff?.files.find((candidate) => candidate.root === root && candidate.path === path)?.patch ??
    null
  const chunks = [...file.chunks].sort((a, b) => a.startLine - b.startLine)

  // The file as it stands on disk — the document's spine. Re-read whenever the tree may have
  // moved, since the agent writes into it while this is on screen. A deleted file reads as
  // empty, and the patch supplies every line it used to have.
  const [text, setText] = useState<string | null>(null)
  /** A changed file whose contents are binary: there is a diff to account for, but no document
   *  to render under it. Rendering one anyway is what froze the app on a PDF. */
  const [binary, setBinary] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRevision is a refetch signal
  useEffect(() => {
    let alive = true
    const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
    void fetch(`/files/content?${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { text?: string; binary?: boolean } | null) => {
        if (!alive) return
        setBinary(body?.binary === true)
        // Keep the *same string object* when the bytes are unchanged. This refetch fires on
        // every `diffRevision` bump — i.e. every edit anywhere in the repo — and a fresh string
        // of identical content is still a new identity, which busts `CodeDocument`'s plan memo
        // and makes it rebuild every decoration for a file nobody touched. Comparing the text
        // costs microseconds.
        setText((was) => {
          const next = body?.text ?? ''
          return was === next ? was : next
        })
      })
      .catch(() => {
        if (!alive) return
        setBinary(false)
        setText('')
      })
    return () => {
      alive = false
    }
  }, [root, path, diffRevision])

  const regions: DocumentRegion[] = chunks.map((chunk) => ({
    key: chunk.key,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }))

  const bands: Record<string, BandInfo> = {}
  for (const chunk of chunks) bands[chunk.key] = bandFor(chunk)

  const lineTotal = text === null || text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
  const slash = path.lastIndexOf('/')

  const facts = [
    file.kind === 'modified' ? null : file.kind,
    binary ? 'binary' : lineTotal > 0 ? `${lineTotal} lines` : null,
    `${chunks.length} ${chunks.length === 1 ? 'change' : 'changes'}`,
    file.added > 0 || file.removed > 0 ? `+${file.added} −${file.removed}` : null,
  ].filter((fact) => fact !== null)

  return (
    <div className="file-pane">
      <header className="file-pane-head">
        <div className="file-pane-title">
          <h2>
            <span className="file-pane-dir">{path.slice(0, slash + 1)}</span>
            <span className="file-pane-name">{path.slice(slash + 1)}</span>
          </h2>
          <span className="file-pane-facts">
            {facts.join(' · ')}
            {file.previousPath !== undefined && ` · renamed from ${file.previousPath}`}
          </span>
        </div>
        <div className="file-pane-actions">
          <NoteCount annotations={notes.annotations} />
          {!binary && (
            <button
              type="button"
              className="btn btn-secondary"
              title="Ask about this file as a whole. Answered now, and nothing is changed."
              onClick={() => asking.open(null, '')}
            >
              Ask about this file
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            title={
              reviewed
                ? 'Not reviewed after all — put it back in the list.'
                : 'Done with this file — it comes back when the agent changes it again.'
            }
            onClick={reviewed ? onShow : onHide}
          >
            {reviewed ? 'Unmark reviewed' : 'Mark reviewed'}
          </button>
          <SendNotes
            annotations={notes.annotations}
            unsentTotal={unsentTotal}
            onSend={onSendNotes}
          />
        </div>
      </header>

      <div className="file-pane-body">
        {binary ? (
          // No document, so no scroller and nowhere for the findings to ride: this branch
          // carries them itself, and scrolls itself.
          <div className="file-pane-static">
            {file.fileFindings.length > 0 && (
              <section className="file-findings">
                <h3>Also found, outside the changes</h3>
                <FindingList findings={file.fileFindings} path={path} />
              </section>
            )}
            <p className="placeholder">
              This is a binary file — it changed, but there are no lines to show.
            </p>
          </div>
        ) : (
          <CodeDocument
            onSave={onSave}
            path={path}
            text={text}
            patch={patch}
            regions={regions}
            bands={bands}
            fileFindings={file.fileFindings}
            scrollKey={scrollKey}
            notes={notes}
            asking={asking}
          />
        )}
      </div>

      <footer className="file-pane-foot">
        <span>{MARKUP_HINT}</span>
        {baselineLabel !== null && (
          <span className="file-pane-foot-end">Measured {baselineLabel}</span>
        )}
      </footer>
    </div>
  )
}

/** The footer both file panes carry: how to mark a file up, which works the same on either. */
export const MARKUP_HINT =
  'Highlight code or drag the line numbers to leave a note or ask — changed or not. ⌘S saves.'

/** "3 notes, 1 sent" — this file's notes, for a pane's header. Nothing when there are none. */
export function NoteCount({ annotations }: { annotations: Annotation[] }) {
  const here = annotations.length
  if (here === 0) return null
  const unsentHere = annotations.filter((note) => note.sentAt === null).length
  return (
    <span className="file-pane-notes">
      {here} {here === 1 ? 'note' : 'notes'},{' '}
      {unsentHere === here
        ? 'none sent'
        : unsentHere === 0
          ? 'all sent'
          : `${here - unsentHere} sent`}
    </span>
  )
}

/**
 * "Send notes", and ⌘⏎ for it — hands every unsent note to the agent, on whichever file pane is
 * showing. `annotations` is this file's, only to say how many of the total are here.
 */
export function SendNotes({
  annotations,
  unsentTotal,
  onSend,
}: {
  annotations: Annotation[]
  unsentTotal: number
  onSend: () => void
}) {
  // ⌘⏎ sends every unsent note, from anywhere but a text box — the composer and the
  // conversation box each give ⌘⏎ a meaning of their own.
  const sendRef = useRef(onSend)
  sendRef.current = onSend
  const canSend = unsentTotal > 0
  useEffect(() => {
    if (!canSend) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
      ) {
        return
      }
      event.preventDefault()
      sendRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canSend])

  const unsentHere = annotations.filter((note) => note.sentAt === null).length
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={unsentTotal === 0}
      title={
        unsentTotal === 0
          ? 'Highlight code or drag over a line to leave a note first.'
          : unsentTotal > unsentHere
            ? `${unsentHere} on this file, ${unsentTotal - unsentHere} elsewhere`
            : 'Hands every unsent note to the agent.'
      }
      onClick={onSend}
    >
      Send notes
      {unsentTotal > 0 && <span className="btn-count">{unsentTotal}</span>}
      <kbd>⌘⏎</kbd>
    </button>
  )
}

/** What a change's card says the review found, or what it is doing instead. */
function bandFor(chunk: LiveChunk): BandInfo {
  if (chunk.status === 'skipped') {
    return {
      tone: 'none',
      label: 'not reviewed',
      reading: false,
      reason: chunk.reason ?? '',
      findings: [],
    }
  }
  const reading = chunk.status === 'analyzing'
  if (chunk.analysis === null) {
    // A pending chunk with a reason had its last review fail; it is retried on the next change.
    if (chunk.status === 'pending' && chunk.reason !== null) {
      return {
        tone: 'none',
        label: 'review failed',
        reading: false,
        reason: chunk.reason,
        findings: [],
      }
    }
    return {
      tone: 'none',
      label: reading ? 'reading' : 'queued',
      reading,
      reason: '',
      findings: [],
    }
  }
  // A review already on screen stays there while its file is read again.
  const level = chunk.analysis.riskLevel
  return {
    tone: TONE[level],
    label: riskLabel(level),
    reading,
    reason: '',
    findings: chunk.analysis.findings,
  }
}

const TONE: Record<RiskLevel, BandInfo['tone']> = {
  high: 'high',
  medium: 'med',
  low: 'low',
  none: 'none',
}
