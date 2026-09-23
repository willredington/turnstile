import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activityOf } from '../../../core/activity.ts'
import { notesForFile, orphanedAnnotations } from '../../../core/annotations.ts'
import type { AutoModeSettings } from '../../../core/autoMode.ts'
import { neighbourOf, openFile, tabKey } from '../../../core/tabs.ts'
import type { BaselineSource, DiffView, SessionState } from '../../../core/types.ts'
import { waitingOn } from '../../../core/waiting.ts'
import { AutoModeSetup } from './AutoModeSetup.tsx'
import { changedFiles, marksByPath, ReviewRail } from './ChangedFiles.tsx'
import { Chevron } from './Chevron.tsx'
import { ContextFileView } from './ContextFileView.tsx'
import { ConversationPanel } from './ConversationPanel.tsx'
import { ProjectTree, useProjectPaths } from './FilesPanel.tsx'
import { FileView } from './FileView.tsx'
import { post, postOrThrow } from './http.ts'
import { OpenTabs } from './OpenTabs.tsx'
import { PermissionOverlay } from './PermissionOverlay.tsx'
import { PlanView } from './PlanView.tsx'
import { QuestionOverlay } from './QuestionOverlay.tsx'
import { TopBar } from './TopBar.tsx'
import { UntrackedPanel } from './UntrackedPanel.tsx'

/**
 * The app shell: one view over a live session. The changed files run down a rail on the left,
 * grouped by what the review made of them, the open one fills the rest, and the conversation
 * docks along the bottom beneath it, hideable to a thin bar. The project tree opens beside the review rail
 * when asked for.
 */

/**
 * The wire payload carries one field `SessionState` itself doesn't declare: `cwd` is a
 * transport-level addition (`server.ts` splices it in, see that file's `displayCwd`) rather
 * than app state.
 */
type ClientState = SessionState & { cwd: string }

const EMPTY: ClientState = {
  status: 'starting',
  sessionId: '',
  transcript: [],
  permissions: [],
  questions: [],
  revision: -1,
  diffRevision: 0,
  chunks: [],
  fileFindings: [],
  roots: [],
  baseline: null,
  annotations: [],
  hidden: [],
  queued: [],
  model: null,
  thinkingLevel: null,
  contextUsed: null,
  contextSize: null,
  planMode: 'default',
  planReview: null,
  tracking: 'unknown',
  cwd: '',
}

/**
 * Live state, pushed but also pulled.
 *
 * The socket carries changes; the fetch covers the gap between the page loading and the
 * socket opening, and the reconnect covers a dropped one. A push-only design races: a client
 * that connects a moment after a change never learns about it.
 */
function useSession(): ClientState {
  const [state, setState] = useState<ClientState>(EMPTY)
  const revision = useRef(-1)

  const accept = useCallback((next: ClientState) => {
    // Out-of-order delivery would otherwise let an older snapshot overwrite a newer one.
    if (next.revision < revision.current) return
    revision.current = next.revision
    setState(next)
  }, [])

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const pull = (): void => {
      void fetch('/state')
        .then((response) => response.json())
        .then(accept)
        .catch(() => {})
    }

    const connect = (): void => {
      socket = new WebSocket(`ws://${location.host}/ws`)
      // Whatever changed while this socket was down — reconnecting alone only resumes the
      // push; it says nothing about what was missed in between.
      socket.onopen = pull
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string; state: ClientState }
          if (message.type === 'state') accept(message.state)
        } catch {
          // A malformed frame is not worth tearing the page down for.
        }
      }
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1000)
      }
    }

    pull()
    connect()

    return () => {
      closed = true
      if (retry !== null) clearTimeout(retry)
      socket?.close()
    }
  }, [accept])

  return state
}

/**
 * The diff against the session's baseline, refetched when the session says it moved.
 *
 * Pulled rather than pushed because it is large and changes on every edit; `diffRevision`
 * is the whole notification, which keeps a stale copy from riding along with unrelated
 * state changes.
 */
function useDiff(revision: number): DiffView | null {
  const [diff, setDiff] = useState<DiffView | null>(null)

  // `revision` is the trigger, not an input: the effect refetches precisely because the
  // session says the tree moved, so depending on it is the entire mechanism.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a refetch signal
  useEffect(() => {
    let live = true
    void fetch('/diff')
      .then((response) => response.json())
      .then((next: DiffView) => {
        if (live) setDiff(next)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [revision])

  return diff
}

type FileId = { root: string; path: string }

/** What the changes are measured from, said in the file pane's footer. */
const BASELINE_LABEL: Record<BaselineSource, string> = {
  'session-start': 'since this session started',
  head: 'since the last commit',
  empty: 'since the repository was empty',
}

/**
 * A panel's shown/hidden state, remembered in this browser. Until the reader toggles it — or
 * when storage is unavailable (a private window, blocked site data) — it starts at `initial`.
 */
function usePanel(name: string, initial: boolean): [boolean, (open: boolean) => void] {
  const storageKey = `turnstile.panel.${name}`
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      return stored === null ? initial : stored !== 'hidden'
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: boolean): void => {
      setOpen(next)
      try {
        localStorage.setItem(storageKey, next ? 'open' : 'hidden')
      } catch {
        // Remembering is a convenience; the panel still toggles without it.
      }
    },
    [storageKey],
  )
  return [open, set]
}

/** A panel's size as a fraction of the space it shares, remembered in this browser the same
 *  way `usePanel` is. */
function usePanelSize(name: string, initial: number): [number, (size: number) => void] {
  const storageKey = `turnstile.panel.${name}`
  const [size, setSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey))
      return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: number): void => {
      setSize(next)
      try {
        localStorage.setItem(storageKey, next.toFixed(4))
      } catch {
        // Remembering is a convenience; the panel still resizes without it.
      }
    },
    [storageKey],
  )
  return [size, set]
}

/**
 * The files the reader has opened from the project tree, remembered in this browser — per
 * project, since one checkout's context files mean nothing in another.
 *
 * The key is the project, and the project does not arrive with the first render: `cwd` is empty
 * until the first state lands. So this starts empty, reads once when a real `cwd` appears, and
 * never writes before then — writing early would file an empty row under the wrong key and lose
 * what was remembered.
 */
function useOpenFiles(cwd: string): [string[], (next: string[]) => void] {
  const storageKey = cwd === '' ? null : `turnstile.open.${cwd}`
  const [open, setOpen] = useState<string[]>([])
  // Which key has already been read. Re-reading on a later render would throw away tabs the
  // reader has opened since.
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    if (storageKey === null || loaded.current === storageKey) return
    loaded.current = storageKey
    try {
      const stored = localStorage.getItem(storageKey)
      const parsed: unknown = stored === null ? [] : JSON.parse(stored)
      setOpen(
        Array.isArray(parsed)
          ? parsed.filter((path): path is string => typeof path === 'string')
          : [],
      )
    } catch {
      // Unreadable, or not what we wrote. An empty row is the safe answer either way.
      setOpen([])
    }
  }, [storageKey])

  const set = useCallback(
    (next: string[]): void => {
      setOpen(next)
      if (storageKey === null) return
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        // Remembering is a convenience; the tabs still work without it.
      }
    },
    [storageKey],
  )
  return [open, set]
}

/**
 * Whether auto-mode is set up, asked once on load; the setup screen reports what it saved. With
 * nothing set up every tool call asks, so the first load opens the setup screen by itself — once
 * per page, since "Later" is an answer too.
 */
function useAutoMode() {
  const [status, setStatus] = useState<'on' | 'off' | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)

  useEffect(() => {
    let live = true
    void fetch('/auto-mode')
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: AutoModeSettings | null) => {
        if (!live || settings === null) return
        setStatus(settings.policy === null ? 'off' : 'on')
        if (settings.policy === null) setSetupOpen(true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  return {
    status,
    setupOpen,
    open: useCallback(() => setSetupOpen(true), []),
    close: useCallback(() => setSetupOpen(false), []),
    saved: useCallback(
      (settings: AutoModeSettings) => setStatus(settings.policy === null ? 'off' : 'on'),
      [],
    ),
  }
}

export function App() {
  const state = useSession()
  const autoMode = useAutoMode()
  const diff = useDiff(state.diffRevision)
  const waiting = waitingOn(state.status)

  const files = useMemo(
    () => changedFiles(diff, state.chunks, state.fileFindings),
    [diff, state.chunks, state.fileFindings],
  )

  // Files the reader has marked reviewed stay off the review rail's list until they change again.
  // The project tree still marks them, and so does their tab — they are still changed.
  const [visibleFiles, hiddenFiles] = useMemo(() => {
    const hidden = new Set(state.hidden.map((file) => tabKey(file.root, file.path)))
    const isHidden = (file: FileId): boolean => hidden.has(tabKey(file.root, file.path))
    return [files.filter((file) => !isHidden(file)), files.filter(isHidden)]
  }, [files, state.hidden])

  // Every file the reader has open, in the order they opened it — pulled up from the project
  // tree or clicked in the rail, with no distinction drawn between the two. Remembered, so the
  // strip survives a reload.
  const [opened, setOpened] = useOpenFiles(state.cwd)

  // Which tab is on screen: one notion of where the reader is. There were two until this — a
  // file picked in the rail and a file opened from the tree — each with its own state, its own
  // way of being cleared, and a precedence rule between them, and a file could be in one or the
  // other but never both.
  const [active, setActive] = useState<string | null>(null)

  // The active tab's changed file, if the board has one for it. This is what decides which pane
  // it gets: the review one — diff marks, findings, notes — for a file the agent has touched,
  // the plain read for anything else. A file the agent changes while it is open swaps pane under
  // the reader without leaving the screen, and swaps back if the agent reverts it.
  const activeFile = active === null ? null : (files.find((file) => file.path === active) ?? null)

  // What tints a file wherever it is drawn — its tab, and its dot in the project tree. One map
  // for both, so the two can never paint the same file two different colours.
  const marks = useMemo(() => marksByPath(files, hiddenFiles), [files, hiddenFiles])

  // The left panel shows the changed files until the reader switches it to the whole project.
  const [showAllFiles, setShowAllFiles] = usePanel('all-files', false)
  // The left panel itself, folded to a thin rail until the reader opens it.
  const [filesOpen, setFilesOpen] = usePanel('files', false)
  // ⌘K asks for the project tree, so it opens the panel as well as switching to it.
  const showAllFilesNow = useCallback(() => {
    setShowAllFiles(true)
    setFilesOpen(true)
  }, [setShowAllFiles, setFilesOpen])
  const projectPaths = useProjectPaths(state.diffRevision)
  const [conversationOpen, setConversationOpen] = usePanel('conversation', true)
  const [conversationHeight, setConversationHeight] = usePanelSize('conversation-height', 1 / 3)

  /** The plan awaiting a decision, and whether the reader is looking at it. */
  const plan = state.planReview
  const [planOnScreen, setPlanOnScreen] = useState(false)

  /**
   * The one way a file gets on screen, wherever it was clicked from: a row in the rail, a row in
   * its reviewed section, the project tree, a note on a file the rail does not list. It opens a
   * tab if there is not one already, and takes the reader off the plan, which stays pinned
   * either way.
   *
   * Opening is all it does. It marks nothing reviewed and unmarks nothing — see `show`.
   */
  const open = useCallback(
    (path: string): void => {
      setOpened(openFile(opened, path))
      setActive(path)
      setPlanOnScreen(false)
    },
    [opened, setOpened],
  )

  const showPlan = useCallback((): void => {
    setPlanOnScreen(true)
  }, [])

  /**
   * A plan arriving is "there is something to read now", so it shows itself.
   *
   * Keyed on the round rather than on `planReview`'s identity: that object is rebuilt on every
   * note, and re-docking on each one would drag the reader back to the plan mid-sentence. The
   * round is also why it had to be made monotonic — it was always 1, so this would have fired
   * for the first plan and never again.
   */
  const round = plan?.round ?? null
  useEffect(() => {
    if (round === null) return
    setPlanOnScreen(true)
  }, [round])

  /** The plan is decided: take it off the screen. */
  const planPending = plan !== null
  useEffect(() => {
    if (!planPending) setPlanOnScreen(false)
  }, [planPending])

  /** The repository a tree-opened file belongs to. Null until a session has opened, which is
   *  also when the tree is still showing the launch directory rather than the checkout. */
  const treeRoot = state.roots[0]?.root ?? null

  /** Whether the reader is actually on the plan, rather than merely having one pending. */
  const onPlan = plan !== null && planOnScreen

  // Marking a file reviewed takes it off the rail's list and leaves it exactly where it is on
  // screen: its tab stays, and its dot turns green. It used to move the reader on to the next
  // file in the rail, which made "I have read this" and "show me something else" one gesture —
  // fine while the rail was the only way through the changes, wrong now that what is open is
  // the reader's own to decide.
  const hide = useCallback((file: FileId): void => {
    void post('/file/hide', file)
  }, [])

  // Taking a reviewed mark back, and nothing else. It deliberately does not select the file:
  // unmarking is something the reader does to a row, from the ↩ beside it, and the file they are
  // reading is whichever one they opened — often this very one, already on screen.
  const show = useCallback((file: FileId): void => {
    void post('/file/show', file)
  }, [])

  // Closing a tab, the way closing a tab anywhere works: the next one along takes the screen, or
  // the one before it when it was last, or nothing when it was the only one. Closing a tab that
  // is not the one on screen moves nothing. A changed file keeps its row in the rail either way
  // — closing its tab says "not now", not "I have read this".
  const closeOpen = useCallback(
    (path: string): void => {
      const next = neighbourOf(opened, opened.indexOf(path))
      setOpened(opened.filter((other) => other !== path))
      if (active === path) setActive(next)
    },
    [opened, active, setOpened],
  )

  const unsentTotal = state.annotations.filter((note) => note.sentAt === null).length
  const mainContent = onPlan ? (
    <PlanView
      // Each revision is its own document, with its own notes and its own scroll position.
      key={plan.round}
      planReview={plan}
      onApprove={() => void post('/plan-review', { decision: 'approve' })}
      onSendBack={(feedback) => void post('/plan-review', { decision: 'reject', feedback })}
      onAnnotate={(rangeStart, line, lineText, body) =>
        void post('/plan-review/annotate', {
          round: plan.round,
          rangeStart,
          line,
          lineText,
          body,
        })
      }
      onRemoveNote={(id) => void post('/plan-review/annotation/remove', { id })}
    />
  ) : activeFile === null && active !== null ? (
    // Keyed on the path, the same way `FileView` below is: without it, switching files keeps
    // the previous one's fetched contents mounted until the new fetch lands, so the pane
    // briefly asserts the old file's answer about the new file.
    <ContextFileView
      key={tabKey(null, active)}
      path={active}
      diff={diff}
      unsentTotal={unsentTotal}
      onSendNotes={() => void post('/notes/send', { text: '' })}
      // Guarded like `onSave`, for the same reason: `annotate` has nowhere to keep a note until
      // a session has opened, and would drop it without a word.
      notes={
        treeRoot === null
          ? undefined
          : {
              annotations: notesForFile(state.annotations, treeRoot, active),
              onAdd: (rangeStart, line, side, lineText, body) =>
                void post('/annotate', {
                  root: treeRoot,
                  path: active,
                  rangeStart,
                  line,
                  side,
                  lineText,
                  body,
                }),
              onRemove: (id) => void post('/annotation/remove', { id }),
            }
      }
      onSave={
        // No root until a session has opened, and `saveFile` would refuse anyway — better
        // to leave the file read-only than to offer a save that cannot land.
        treeRoot === null
          ? undefined
          : (text) => postOrThrow('/file/save', { root: treeRoot, path: active, text })
      }
    />
  ) : activeFile !== null ? (
    <FileView
      key={tabKey(activeFile.root, activeFile.path)}
      file={activeFile}
      diff={diff}
      unsentTotal={unsentTotal}
      diffRevision={state.diffRevision}
      baselineLabel={state.baseline === null ? null : BASELINE_LABEL[state.baseline]}
      onSendNotes={() => void post('/notes/send', { text: '' })}
      reviewed={hiddenFiles.includes(activeFile)}
      onHide={() => hide({ root: activeFile.root, path: activeFile.path })}
      onShow={() => show({ root: activeFile.root, path: activeFile.path })}
      onSave={(text) =>
        postOrThrow('/file/save', { root: activeFile.root, path: activeFile.path, text })
      }
      notes={{
        annotations: notesForFile(state.annotations, activeFile.root, activeFile.path),
        onAdd: (rangeStart, line, side, lineText, body) =>
          void post('/annotate', {
            root: activeFile.root,
            path: activeFile.path,
            rangeStart,
            line,
            side,
            lineText,
            body,
          }),
        onRemove: (id) => void post('/annotation/remove', { id }),
      }}
    />
  ) : null

  return (
    <div className="app">
      <TopBar
        activity={activityOf(state)}
        diff={diff}
        sessionId={state.sessionId}
        switchDisabled={waiting.busy}
        switchDisabledReason={waiting.closed}
        cwd={state.cwd}
        model={state.model}
        thinkingLevel={state.thinkingLevel}
        contextUsed={state.contextUsed}
        contextSize={state.contextSize}
        autoMode={autoMode.status}
        onAutoMode={autoMode.open}
      />

      {state.tracking === 'not-git' ? (
        <UntrackedPanel cwd={state.cwd} />
      ) : (
        <>
          {opened.length > 0 && (
            <OpenTabs
              paths={opened}
              marks={marks}
              selected={onPlan ? null : active}
              onSelect={open}
              onClose={closeOpen}
            />
          )}

          <div className="workspace">
            <div className="workspace-left">
              {!filesOpen && (
                <button
                  type="button"
                  className="side-rail"
                  title="Show the files"
                  onClick={() => setFilesOpen(true)}
                >
                  <Chevron dir="right" />
                  <span className="side-rail-label">files</span>
                  {visibleFiles.length > 0 && (
                    <span className="side-rail-meta">{visibleFiles.length} changed</span>
                  )}
                  {plan !== null && <span className="side-rail-meta">plan</span>}
                </button>
              )}
              {/* Hidden rather than unmounted, so folds, scroll and the tree's filter survive. */}
              <div className="workspace-left-panel" hidden={!filesOpen}>
                <ReviewRail
                  onCollapse={() => setFilesOpen(false)}
                  onReviewNow={() => void post('/review', {})}
                  agentWorking={state.status === 'working'}
                  files={visibleFiles}
                  hidden={hiddenFiles}
                  annotations={state.annotations}
                  plan={plan}
                  selected={onPlan ? null : activeFile}
                  planSelected={onPlan}
                  showAll={showAllFiles}
                  allCount={Array.isArray(projectPaths) ? projectPaths.length : null}
                  tree={
                    <ProjectTree
                      paths={projectPaths}
                      onShow={showAllFilesNow}
                      files={files}
                      reviewed={hiddenFiles}
                      orphanedNotes={orphanedAnnotations(state.annotations, files)}
                      onRemoveNote={(id) => void post('/annotation/remove', { id })}
                      selectedPath={onPlan ? null : active}
                      onOpenFile={open}
                    />
                  }
                  onSelect={(file) => open(file.path)}
                  onSelectPlan={showPlan}
                  onHide={hide}
                  onShow={show}
                  onShowAllChange={setShowAllFiles}
                />
              </div>
            </div>

            <div className="workspace-center">
              <main className="main-column">
                {/* Nothing is on screen unless the reader opened it — so "nothing open" is its
                    own answer, and a different one from "nothing to open". */}
                {mainContent ??
                  (files.length === 0 ? (
                    <div className="main-empty">
                      <p>Nothing has changed in this session yet.</p>
                      <p className="main-empty-sub">
                        Every file the agent touches shows up in the rail, and is reviewed when its
                        turn ends.
                      </p>
                    </div>
                  ) : visibleFiles.length === 0 ? (
                    <div className="main-empty">
                      <p>Every changed file has been reviewed.</p>
                      <p className="main-empty-sub">
                        Each one comes back by itself when the agent changes it again, or from the
                        reviewed menu at the foot of the rail.
                      </p>
                    </div>
                  ) : (
                    <div className="main-empty">
                      <p>Nothing open.</p>
                      <p className="main-empty-sub">
                        Open a file from the rail to read it — it stays in the strip along the top
                        until you close it.
                      </p>
                    </div>
                  ))}
              </main>

              <ConversationPanel
                state={state}
                waiting={waiting}
                open={conversationOpen}
                onOpenChange={setConversationOpen}
                height={conversationHeight}
                onHeightChange={setConversationHeight}
              />
            </div>
          </div>
        </>
      )}

      {/* Both are `position: fixed; inset: 0` at the same z-index — when a permission prompt
          and a clarifying question are pending at once, DOM order alone puts the question on
          top, since answering it is usually what unblocks whatever else is waiting. */}
      {autoMode.setupOpen && <AutoModeSetup onClose={autoMode.close} onSaved={autoMode.saved} />}
      <PermissionOverlay permissions={state.permissions} />
      <QuestionOverlay questions={state.questions} />
    </div>
  )
}
