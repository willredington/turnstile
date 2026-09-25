import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { forceParsing, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentPlan } from '../../../../core/documentPlan.ts'
import { pathToLanguage } from '../../../../core/language.ts'
import { decorationField, decorationsFor, setDecorations } from './decorations.ts'
import { codeHighlight } from './highlight.ts'
import { hostPortals, useHosts } from './hosts.tsx'
import { languageFor } from './language.ts'
import { useMarkup } from './markup.tsx'
import { type NoteTarget, SaveBar } from './parts.tsx'
import { recallScroll, rememberScroll } from './scrollMemory.ts'
import type { Ask } from './useAsk.ts'
import { useSaveable } from './useSaveable.ts'

/**
 * A plain file has no bands, removals or folds — nothing here has been reviewed and there is no
 * diff to fold — so these only need to exist. Notes and questions are added separately, by
 * `useMarkup`, rather than coming out of a document plan.
 */
const NO_WIDGETS = {
  band: () => {
    throw new Error('a plain file has no bands')
  },
  removal: () => {
    throw new Error('a plain file has no removals')
  },
  fold: () => {
    throw new Error('a plain file has no folds')
  },
}

/**
 * A whole file, with some of its lines marked — the surface for a file opened from the project
 * tree rather than from the board.
 *
 * No bands and no findings, since nothing here has been reviewed. Notes and questions work
 * exactly as they do on the board's document — the same gestures, through the same `useMarkup` —
 * because whether the agent touched a file has no bearing on wanting to say something about
 * it. It is editable on the same terms as the document view, through the same `useSaveable`,
 * so "unsaved", "the file moved underneath you" and "the save was refused" behave identically
 * on both. It shares `decorationsFor` too, so "a changed line looks like this" is decided in
 * exactly one place.
 */
export function PlainCode({
  path,
  text,
  changedLines,
  scrollKey,
  asking,
  notes,
  onSave,
}: {
  path: string
  text: string
  /** New-file line numbers this session touched. */
  changedLines: ReadonlySet<number>
  /** Which tab this is, for remembering where it was scrolled to. */
  scrollKey: string
  /** The questions asked about this tab. A file nobody changed is still worth asking about —
   *  arguably more so, since there is no review on it to read. */
  asking: Ask
  /** Where notes on this file go. Absent until a session has opened, since there is nowhere to
   *  keep one before then — the composer then offers only a question. */
  notes?: NoteTarget
  /** Save the reader's own edit. Absent leaves the file read-only. */
  onSave?: (text: string) => Promise<void> | void
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const saveable = useSaveable(onSave)
  const { view, synced, save } = saveable
  const registry = useHosts()
  const markup = useMarkup(view, registry, notes, asking)

  /** The file as the props currently describe it, read by the build effect below. */
  const textProp = useRef(text)
  textProp.current = text

  const language = useMemo(() => languageFor(pathToLanguage(path)), [path])
  /** The stable stand-in for `changedLines`, whose Set identity changes every render. */
  const marks = useMemo(() => [...changedLines].sort((a, b) => a - b).join(','), [changedLines])

  /**
   * Built once per file, not per keystroke.
   *
   * This used to rebuild the whole view whenever the text changed, which was harmless while it
   * was read-only and would now throw away whatever the reader had typed.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `host` is the signal the container exists; `path` gives each file a fresh view. The markup extensions are built once.
  useEffect(() => {
    if (host === null) return
    const content = textProp.current
    synced.current = content

    const state = EditorState.create({
      doc: content,
      extensions: [
        ...markup.extensions,
        syntaxHighlighting(codeHighlight, { fallback: true }),
        ...(language === null ? [] : [language]),
        decorationField,
        history(),
        // Before the general keymap, so ⌘S is a save rather than whatever else claims it.
        ...saveable.extensions,
        keymap.of([...historyKeymap, ...defaultKeymap]),
      ],
    })

    const created = new EditorView({
      state,
      parent: host,
      // Where this tab was when it was last on screen. CodeMirror applies this in its first
      // measure pass, after forcing the viewport to cover the line it names — which is why it
      // is handed to the constructor rather than dispatched once the view is up.
      scrollTo: recallScroll(scrollKey),
    })
    view.current = created

    // Recorded as the reader scrolls, not on the way out. React mutates the DOM before it
    // flushes effect cleanups, so by the time the cleanup below runs this view's scroller is
    // already detached — and a detached element reports `scrollTop` 0, which would file every
    // tab as being at the top of its file. Measured, not assumed: `isConnected` is false there.
    //
    // The first scroll event a restored view gets is the restore itself, so this records the
    // position it was given rather than clobbering it.
    const onScroll = (): void => {
      rememberScroll(scrollKey, created.scrollSnapshot())
    }
    created.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    // Highlight what the reader is actually looking at, before they look at it.
    //
    // Lezer parses forward from the start of the document, and a restored view opens partway
    // down one — so the tree has to reach the viewport before any of it is coloured, and the
    // background parser does that in idle slices that can pause for up to half a second. The
    // measured cost of leaving it alone was a third of a second of raw text on a 2,500-line
    // file. Run after a frame, because the scroll position is only applied in the first
    // measure pass and `viewport` names the top of the file until it is. Bounded, so a file
    // too big to parse in time degrades to what it did before rather than blocking the frame.
    const parsed = requestAnimationFrame(() => {
      forceParsing(created, created.viewport.to, 150)
    })

    return () => {
      cancelAnimationFrame(parsed)
      created.scrollDOM.removeEventListener('scroll', onScroll)
      created.destroy()
      view.current = null
    }
  }, [host, path, language, scrollKey])

  /** The file changed on disk — take it, unless the reader is mid-edit. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `host` is how this re-runs once the view exists.
  useEffect(() => {
    const current = view.current
    if (current === null) return
    if (!saveable.shouldAccept(text)) return
    if (current.state.doc.toString() === text) return
    synced.current = text
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } })
  }, [host, text])

  /** Which lines this session changed, and whatever has been written or asked about them. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `marks` stands in for `changedLines`; `host` for the view existing.
  useEffect(() => {
    const current = view.current
    if (current === null) return
    const plan: DocumentPlan = {
      bands: [],
      removals: [],
      folds: [],
      accents: [...changedLines]
        .sort((a, b) => a - b)
        .map((line) => ({ line, kind: 'add' as const, chunkKey: '' })),
    }
    let decorations = decorationsFor(current.state, plan, NO_WIDGETS)
    const extra = markup.decorate(current.state)
    if (extra.length > 0) decorations = decorations.update({ add: extra, sort: true })
    current.dispatch({ effects: setDecorations.of(decorations) })
  }, [host, marks, markup.decorate])

  const portals = hostPortals(registry, markup.portal)

  return (
    <>
      <SaveBar
        dirty={saveable.dirty}
        conflict={saveable.conflict}
        refusal={saveable.refusal}
        onSave={() => void save()}
      />
      <div ref={setHost} className="ts-editor" />
      {portals}
    </>
  )
}
