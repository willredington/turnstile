import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { forceParsing, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildDocumentPlan,
  type DocumentRegion,
  type PlanFold,
  type PlanRemoval,
} from '../../../../core/documentPlan.ts'
import { pathToLanguage } from '../../../../core/language.ts'
import type { Finding, ParsedPatch } from '../../../../core/types.ts'
import {
  type BlockWidgets,
  decorationField,
  decorationsFor,
  headerDecoration,
  setDecorations,
} from './decorations.ts'
import { codeHighlight } from './highlight.ts'
import { HostWidget, hostPortals, useHosts } from './hosts.tsx'
import { languageFor } from './language.ts'
import { useMarkup } from './markup.tsx'
import { Band, type BandInfo, FindingList, type NoteTarget, SaveBar } from './parts.tsx'
import { recallScroll, rememberScroll } from './scrollMemory.ts'
import type { Ask } from './useAsk.ts'
import { useSaveable } from './useSaveable.ts'

/**
 * The file as one document, with its own changes marked in place — on CodeMirror.
 *
 * Replaces a hand-built virtualized list. The reading model is unchanged and deliberately so:
 * every line the file has, in file order, changes tinted where they fall, what was removed
 * struck through where it was, each change announced by a band, findings and notes set into
 * the document beside the code. What changed is the engine underneath it.
 *
 * Three things CodeMirror does that the list could not:
 *   - it windows the document itself, so there is no row-measuring to keep honest;
 *   - it parses incrementally, so a keystroke reparses a region rather than the whole file
 *     (the Shiki pass this replaces cost ~270 ms per edit on a 759-line file, which is why
 *     the pane could never become editable);
 *   - it has real block widgets, so a card between two lines is a first-class thing rather
 *     than a row spliced into a list.
 *
 * `core/documentPlan.ts` decides what belongs where; `decorations.ts` turns that into
 * CodeMirror's vocabulary; this file owns the React that lives inside the blocks.
 */

/** Removed lines are static text, so they are built directly rather than through React. */
function removalDOM(removal: PlanRemoval): HTMLElement {
  const el = document.createElement('div')
  el.className = 'ts-removed'
  for (const text of removal.texts) {
    const row = document.createElement('div')
    row.className = 'ts-removed-line'
    // An empty removed line still needs height, or the strike-through has nothing to sit on.
    row.textContent = text === '' ? ' ' : text
    el.appendChild(row)
  }
  return el
}

class RemovalWidget extends WidgetType {
  constructor(readonly removal: PlanRemoval) {
    super()
  }
  eq(other: RemovalWidget): boolean {
    return (
      other.removal.line === this.removal.line &&
      other.removal.texts.length === this.removal.texts.length &&
      other.removal.texts.every((text, i) => text === this.removal.texts[i])
    )
  }
  toDOM(): HTMLElement {
    return removalDOM(this.removal)
  }
}

class FoldWidget extends WidgetType {
  constructor(
    readonly fold: PlanFold,
    readonly onOpen: (startLine: number) => void,
  ) {
    super()
  }
  eq(other: FoldWidget): boolean {
    return other.fold.startLine === this.fold.startLine && other.fold.endLine === this.fold.endLine
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ts-fold'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ts-fold-button'
    button.textContent = `⋯ ${this.fold.lineCount} unchanged lines`
    button.addEventListener('click', () => this.onOpen(this.fold.startLine))
    el.appendChild(button)
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

export function CodeDocument({
  path,
  text,
  patch,
  regions,
  bands,
  fileFindings,
  scrollKey,
  notes,
  asking,
  onSave,
}: {
  path: string
  /** The file as it stands on disk. Null while it is still being read. */
  text: string | null
  patch: ParsedPatch | null
  regions: DocumentRegion[]
  bands: Record<string, BandInfo>
  /** What the review found about the file rather than about any one of its changes. Rides at
   *  the top of the document, so it scrolls with the file instead of sitting above it. */
  fileFindings: Finding[]
  /** Which tab this is, for remembering where it was scrolled to. */
  scrollKey: string
  notes: NoteTarget
  /** The questions asked about this tab. Owned by the view above, which also puts an
   *  "Ask about this file" button in its header against the same threads. */
  asking: Ask
  /** Save the reader's own edit. Absent for a surface that is only for reading. */
  onSave?: (text: string) => Promise<void> | void
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  /** Editing, and the bookkeeping that keeps unsaved work safe — shared with `PlainCode`. */
  const saveable = useSaveable(onSave)
  const { view, synced, save } = saveable
  /** The file as the props currently describe it. */
  const textProp = useRef<string | null>(text)
  textProp.current = text
  const registry = useHosts()

  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())

  // `findingsKey` stands in for `fileFindings` the way `shape` does for `regions`: the review
  // rebuilds the array on every poll, but what it holds settles early.
  const findingsKey = fileFindings.map((f) => `${f.title}:${f.startLine}`).join('|')

  // `shape` stands in for `regions`, whose array identity changes every render but whose
  // contents almost never do.
  const shape = regions.map((r) => `${r.key}:${r.startLine}-${r.endLine}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the stable stand-in for `regions`.
  const plan = useMemo(
    () => (text === null || patch === null ? null : buildDocumentPlan(text, patch, regions)),
    [text, patch, shape],
  )

  const language = useMemo(() => languageFor(pathToLanguage(path)), [path])
  const markup = useMarkup(view, registry, notes, asking, plan?.removals)

  // Build the view once per file. A new document for the same path is a dispatch, not a
  // rebuild, so scroll position and selection survive the agent saving the file.
  /**
   * `host` and `path` look redundant to the linter and are not.
   *
   * `host` is the signal that the container exists: it arrives in a later commit than the
   * first render (the file is still being read), and without it this effect runs once against
   * nothing and never again. `path` rebuilds the view per file, so that switching between two
   * files of the same language starts at the top instead of inheriting the previous file's
   * scroll position and selection.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: both are load-bearing; see above.
  useEffect(() => {
    const content = textProp.current
    if (host === null || content === null) return
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
        EditorView.lineWrapping,
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

  /**
   * The file changed under us — take the new text, unless the reader is mid-edit.
   *
   * Replacing the document while there is unsaved typing in it would throw that typing away
   * without asking, so unsaved work always wins the race. What the reader is told instead is
   * that the file moved: ⌘S then overwrites with what is on screen, which is the same choice
   * any editor gives you, made explicit rather than silently.
   */
  // `host` is how this re-runs once the build effect above has created the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    const current = view.current
    if (current === null || text === null) return
    if (!saveable.shouldAccept(text)) return
    if (current.state.doc.toString() === text) return
    synced.current = text
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: text },
    })
  }, [host, text])

  // Push decorations whenever what belongs on the page changes.
  // `host` is how this re-runs once the build effect above has created the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    const current = view.current
    if (current === null) return

    const widgets: BlockWidgets = {
      band: (band) => new HostWidget(`band:${band.chunkKey}`, 'ts-band-host', registry),
      removal: (removal) => new RemovalWidget(removal),
      fold: (fold) =>
        new FoldWidget(fold, (startLine) =>
          setOpened((previous) => new Set(previous).add(startLine)),
        ),
    }

    // No plan yet means the diff is still in flight. The file-level findings do not depend on
    // it, so they go up now rather than waiting for a patch that says nothing about them.
    let decorations =
      plan === null
        ? Decoration.none
        : decorationsFor(
            current.state,
            { ...plan, folds: plan.folds.filter((fold) => !opened.has(fold.startLine)) },
            widgets,
          )

    // Notes, questions and the composer sit below the line they are about, so they are added
    // after the plan's own blocks rather than being part of it — the plan describes the diff,
    // not what the reader has written on it.
    const extra = []
    if (fileFindings.length > 0) {
      extra.push(
        headerDecoration(new HostWidget('file-findings', 'ts-file-findings-host', registry)),
      )
    }
    extra.push(...markup.decorate(current.state))
    if (extra.length > 0) {
      decorations = decorations.update({ add: extra, sort: true })
    }

    current.dispatch({ effects: setDecorations.of(decorations) })
  }, [host, plan, opened, findingsKey, markup.decorate])

  const sizes = useMemo(() => {
    const out = new Map<string, { added: number; removed: number }>()
    if (plan === null) return out
    for (const band of plan.bands) out.set(band.chunkKey, { added: 0, removed: 0 })
    for (const accent of plan.accents) {
      if (accent.kind !== 'add') continue
      const size = out.get(accent.chunkKey)
      if (size !== undefined) size.added += 1
    }
    for (const removal of plan.removals) {
      if (removal.chunkKey === null) continue
      const size = out.get(removal.chunkKey)
      if (size !== undefined) size.removed += removal.texts.length
    }
    return out
  }, [plan])

  const portals = hostPortals(registry, (id) => {
    if (id === 'file-findings') {
      return (
        <section className="file-findings">
          <h3>Also found, outside the changes</h3>
          <FindingList findings={fileFindings} path={path} />
        </section>
      )
    }
    if (id.startsWith('band:')) {
      if (plan === null) return null
      const key = id.slice('band:'.length)
      const band = plan.bands.find((candidate) => candidate.chunkKey === key)
      const info = bands[key]
      if (band === undefined || info === undefined) return null
      return (
        <Band
          span={band}
          info={info}
          path={path}
          size={sizes.get(key) ?? { added: 0, removed: 0 }}
        />
      )
    }
    return markup.portal(id)
  })

  if (text === null) return <p className="placeholder">Reading the file…</p>

  return (
    <div className="ts-document">
      <SaveBar
        dirty={saveable.dirty}
        conflict={saveable.conflict}
        refusal={saveable.refusal}
        onSave={() => void save()}
      />
      <div ref={setHost} className="ts-editor" />
      {portals}
    </div>
  )
}
