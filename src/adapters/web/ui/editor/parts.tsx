import { useEffect, useRef, useState } from 'react'
import type { Annotation, Finding } from '../../../../core/types.ts'

/**
 * The block-level cards the document sets into the file: a change's band, the review's
 * findings, a note, and the composer for writing one.
 *
 * Presentational only, and deliberately ignorant of how they get on screen — `CodeDocument`
 * mounts each one into a CodeMirror block widget through a portal, which is why none of them
 * may assume anything about their parent.
 */

export type NoteTarget = {
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

/** What a change's card says about itself. Assembled by `FileView`, which owns the vocabulary
 *  of review levels; these components only lay it out. */
export type BandInfo = {
  /** How loudly the card is painted — the worst finding's severity, or `none`. */
  tone: 'high' | 'med' | 'low' | 'none'
  /** "medium", "no findings", or what the review is doing instead of having an answer yet. */
  label: string
  /** The review is reading this change right now. */
  reading: boolean
  /** Why it was not reviewed, or why the review failed. Empty otherwise. */
  reason: string
  /** What the review found on this change. */
  findings: Finding[]
}

const SEVERITY_TONE: Record<Finding['severity'], BandInfo['tone']> = {
  high: 'high',
  medium: 'med',
  low: 'low',
}

/** Review findings, each with its severity, the rule it breaks, where it is and what the rule
 *  asks for. */
export function FindingList({
  findings,
  path,
}: {
  findings: Finding[]
  /** The file on screen: a finding anywhere else says which file it is in. */
  path: string
}) {
  return (
    <ul className="findings">
      {findings.map((finding, index) => {
        const lines =
          finding.endLine > finding.startLine
            ? `${finding.startLine}–${finding.endLine}`
            : `${finding.startLine}`
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: findings have no identity of their own, and the list is replaced whole.
          <li key={index} className="finding">
            <span className={`sev sev-${SEVERITY_TONE[finding.severity]}`}>{finding.severity}</span>
            <span className="finding-rule">{finding.rule}</span>
            <span className="finding-where">
              {finding.path === path ? `line ${lines}` : `${finding.path}:${lines}`}
            </span>
            <p className="finding-message">{finding.message}</p>
          </li>
        )
      })}
    </ul>
  )
}

/** The announcement above a change. Takes the span rather than a row, so the same card serves
 *  whichever model put it there. */
export function Band({
  span,
  info,
  path,
  size,
}: {
  span: { startLine: number; endLine: number; lineCount: number }
  info: BandInfo
  path: string
  size: { added: number; removed: number }
}) {
  const lines =
    span.lineCount === 0
      ? `at line ${span.startLine}`
      : span.endLine > span.startLine
        ? `lines ${span.startLine}–${span.endLine}`
        : `line ${span.startLine}`
  const counts = [
    size.added > 0 ? `+${size.added}` : null,
    size.removed > 0 ? `−${size.removed}` : null,
  ]
    .filter((count) => count !== null)
    .join(' ')

  return (
    <div className={`grp grp-${info.tone}`}>
      <span className="grp-bar" />
      <div className="grp-body">
        <div className="grp-head">
          <span className="grp-where">{lines}</span>
          <span className={`sev sev-${info.tone}`}>
            {info.reading && <span className="spinner spinner-inline" aria-hidden="true" />}
            {info.label}
          </span>
          {counts !== '' && <span className="grp-meta">{counts}</span>}
        </div>
        {info.reason !== '' && <p className="grp-why">{info.reason}</p>}
        {info.findings.length > 0 && <FindingList findings={info.findings} path={path} />}
      </div>
    </div>
  )
}

/**
 * What a drag over the gutter can turn into.
 *
 * Two verbs on one gesture rather than two gestures: you have already said which lines you mean
 * and typed what you have to say, and whether that becomes work for the agent or a question
 * answered here is the last thing you decide, not the first.
 */
/**
 * Take the cursor on mount.
 *
 * `autoFocus` does not work here. These boxes render through a portal into an element
 * CodeMirror created for a block widget, and React's autoFocus fires during the commit that
 * mounts them — before that element is placed — so the focus call lands on a node that cannot
 * take it and is silently dropped. An effect runs late enough that it can.
 *
 * Not `requestAnimationFrame`, which is the obvious way to wait "one more beat": frames are
 * suspended in a background tab, so the focus would simply never happen there — and that failure
 * is invisible until someone is looking at the wrong window. This is the second time that has
 * bitten this file's neighbours; see the scroll-memory work.
 *
 * It matters more than it looks: a box that appears where you were reading and does not take the
 * cursor makes you click it before you can type, which is the click the box existed to save.
 */
export function useTakesTheCursor<T extends HTMLElement>(when = true) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!when) return
    // The caller is responsible for the editor having let go first — see `useSelectionAsk`'s
    // `handOff`. CodeMirror re-asserts DOM focus on its content while it believes it has it,
    // and it wins every race against a box that merely focuses itself afterwards.
    ref.current?.focus()
  }, [when])
  return ref
}

/**
 * Ask about the selection, right where it is.
 *
 * Fixed-position, and deliberately NOT a block widget in the document — which is what the first
 * attempt was, and why it had to be rewritten. A widget inside the document changes the
 * document's geometry; that is an editor update; an editor update re-reads the selection; and
 * re-reading the selection puts the widget back. Every guard against that loop was another
 * patch on it, and one of them still managed to lock the renderer. Nothing outside the editor
 * can feed back into it, so this cannot.
 *
 * It also settles the focus fight for free. CodeMirror re-asserts DOM focus on its content
 * whenever it updates while focused, so an in-document box could take the cursor and lose it
 * again a moment later. This causes no update, so the cursor stays where it was put.
 *
 * Used where one verb is all a selection can become — asking, on a file nobody changed; leaving
 * a note, on a plan. Where it could be either, the selection opens the full composer instead,
 * because that choice needs making. The words are passed in rather than assumed, so the box does
 * not tell a reader annotating a plan that they are about to ask a question.
 */
export function SelectionQuestion({
  left,
  top,
  rangeLabel,
  kicker = 'question',
  placeholder = 'What do you want to know?',
  verb = 'ask',
  onAsk,
  onDismiss,
}: {
  left: number
  top: number
  rangeLabel: string
  /** What the box says it is collecting. */
  kicker?: string
  placeholder?: string
  /** What ⏎ does, in the hint under the box. */
  verb?: string
  onAsk: (question: string) => void
  onDismiss: () => void
}) {
  const [draft, setDraft] = useState('')
  const box = useTakesTheCursor<HTMLTextAreaElement>()

  return (
    <div className="selection-question" style={{ left, top }}>
      <div className="selection-question-head">
        <span className="composer-kicker">{kicker}</span>
        <span className="composer-target">{rangeLabel}</span>
      </div>
      <textarea
        ref={box}
        rows={1}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onDismiss()
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            const question = draft.trim()
            if (question !== '') onAsk(question)
          }
        }}
      />
      <span className="selection-question-hint">
        <kbd>⏎</kbd> to {verb} · <kbd>esc</kbd> to dismiss
      </span>
    </div>
  )
}

export type ComposerState = {
  rangeLabel: string
  draft: string
  onDraftChange: (value: string) => void
  onCancel: () => void
  /** Which verb the gesture was reaching for. The other is still offered. */
  intent: 'note' | 'ask'
  /**
   * Leave it as a note: deferred, addressed to the agent, waits to be sent.
   *
   * Absent on a surface with no board behind it. A file opened from the project tree is not up
   * for review, so a note on it would be one nobody ever sees again — better to not offer the
   * verb than to offer it and drop what was typed.
   */
  onSave?: () => void
  /**
   * Ask it instead: answered now, by a different model, and changes nothing.
   *
   * Absent on a surface with nothing to read the answer from. A plan is not a file, and the
   * asker reads its subject off disk — offering the verb there would fail every time.
   */
  onAsk?: () => void
}

export function Composer({ state }: { state: ComposerState }) {
  const empty = state.draft.trim() === ''
  /**
   * The verb Enter means, when there is only one of them.
   *
   * Where both are on offer Enter has to stay a newline, because there is no way to guess which
   * one was meant. Where only one is, making the reader reach for the mouse to do the only thing
   * they could do is a step that decides nothing.
   */
  const only =
    state.onSave === undefined ? state.onAsk : state.onAsk === undefined ? state.onSave : undefined
  /** With only one verb it leads, whatever the gesture was reaching for. */
  const askLeads =
    state.onSave === undefined || (state.onAsk !== undefined && state.intent === 'ask')
  const box = useTakesTheCursor<HTMLTextAreaElement>()

  const ask =
    state.onAsk === undefined ? null : (
      <button
        type="button"
        className={`btn ${askLeads ? 'btn-primary' : 'btn-secondary'}`}
        disabled={empty}
        onClick={state.onAsk}
      >
        Ask
      </button>
    )
  const note =
    state.onSave === undefined ? null : (
      <button
        type="button"
        className={`btn ${askLeads ? 'btn-secondary' : 'btn-primary'}`}
        disabled={empty}
        onClick={state.onSave}
      >
        Leave note
      </button>
    )

  return (
    <div className="composer open">
      <div className="composer-head">
        <span className="composer-kicker">{state.intent === 'ask' ? 'question' : 'selection'}</span>
        <span className="composer-target">{state.rangeLabel}</span>
      </div>
      <textarea
        ref={box}
        value={state.draft}
        placeholder={
          state.intent === 'ask'
            ? 'What do you want to know about these lines?'
            : state.onAsk === undefined
              ? 'What is wrong with these lines of the plan?'
              : 'Leave a note for the agent, or ask a question about these lines.'
        }
        onChange={(event) => state.onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') state.onCancel()
          if (only !== undefined && event.key === 'Enter' && !event.shiftKey && !empty) {
            event.preventDefault()
            only()
          }
        }}
      />
      <div className="composer-foot">
        <span className="composer-hint">
          {state.onSave === undefined ? (
            <>
              Answered now, and nothing is changed. <kbd>⏎</kbd> to ask.
            </>
          ) : state.onAsk === undefined ? (
            <>
              Goes back with the plan when you send it. <kbd>⏎</kbd> to leave it.
            </>
          ) : (
            'A note waits until you send it. A question is answered now, and changes nothing.'
          )}
        </span>
        <button type="button" className="btn btn-secondary" onClick={state.onCancel}>
          Cancel <kbd>esc</kbd>
        </button>
        {askLeads ? (
          <>
            {note}
            {ask}
          </>
        ) : (
          <>
            {ask}
            {note}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One note, as a card set into the document under the line it is about.
 *
 * A sent note stays visible and says so. It is the record of what was asked for, and hiding it
 * the moment it is delivered is the vanishing act the board exists to stop.
 */
export function NoteBand({
  annotation,
  state,
  onRemove,
}: {
  annotation: Annotation
  /** What this note is waiting for, when "sent" is not the thing that happens to it. A note on
   *  a plan never goes on its own — it rides back with the refusal — so `sentAt` would label it
   *  "not sent" forever and imply a Send that does not exist here. */
  state?: string
  onRemove?: (id: string) => void
}) {
  const sent = annotation.sentAt !== null
  const removable = !sent && onRemove !== undefined

  const where =
    annotation.rangeStart < annotation.line
      ? `lines ${annotation.rangeStart}–${annotation.line}`
      : `line ${annotation.line}`
  const sentAt =
    annotation.sentAt === null
      ? null
      : new Date(annotation.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`note${sent ? ' sent' : ''}`}>
      <div className="note-head">
        <span className="note-who">
          <span className="note-dot" />
          your note
        </span>
        <span className="note-where">
          {where}
          {annotation.side === 'old' && ' (removed)'}
        </span>
        <span className="note-state">
          {state ?? (sentAt === null ? 'not sent' : `sent ${sentAt}`)}
        </span>
      </div>
      <p className="note-body">{annotation.body}</p>
      {removable && (
        <div className="note-actions">
          <button type="button" className="note-remove" onClick={() => onRemove(annotation.id)}>
            Remove
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * What is standing between the reader's typing and the disk.
 *
 * Three states, in the order they matter: a save that was refused (the work is still only on
 * screen, and why), the file having moved underneath unsaved work (saving now overwrites it),
 * and plain unsaved changes. Shown by both document surfaces.
 */
export function SaveBar({
  dirty,
  conflict,
  refusal,
  onSave,
}: {
  dirty: boolean
  conflict: boolean
  refusal: string | null
  onSave: () => void
}) {
  if (!dirty && !conflict && refusal === null) return null

  const wrong = refusal !== null || conflict
  return (
    <div className={`ts-save${wrong ? ' conflict' : ''}`}>
      <span className="ts-save-what">
        {refusal !== null
          ? `Not saved — ${refusal}`
          : conflict
            ? 'This file changed on disk while you were editing it.'
            : 'Unsaved changes'}
      </span>
      <button type="button" className="btn btn-primary" onClick={onSave}>
        {conflict ? 'Overwrite' : refusal !== null ? 'Try again' : 'Save'} <kbd>⌘S</kbd>
      </button>
    </div>
  )
}
