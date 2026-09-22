import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { levelOf } from '../../../core/findings.ts'
import { tabKey } from '../../../core/tabs.ts'
import type {
  Annotation,
  DiffView,
  FileFindings,
  Finding,
  LiveChunk,
  PlanReviewState,
  RiskLevel,
} from '../../../core/types.ts'
import { Chevron } from './Chevron.tsx'

/**
 * Every file the session has changed since its baseline, one row each, riskiest first.
 *
 * There is nothing to decide here. A file is listed exactly as long as it differs from
 * where the agent started — committed or not — and it says what the review made of it and
 * how many notes you have left on it.
 */

export type ChangedFile = {
  root: string
  path: string
  previousPath?: string
  /** "modified" / "created" / "deleted" / "renamed" / "binary". */
  kind: string
  added: number
  removed: number
  chunks: LiveChunk[]
  /** Review findings on this file that land on none of its changes. */
  fileFindings: Finding[]
}

const RISK_RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2, none: 3 }

/**
 * The worst (most concerning) level reviewed so far for a file, if any: its chunks', and its
 * file-level findings' — a change that breaks a caller elsewhere is as serious as that break,
 * even though the break is not in any of its lines.
 */
function worstRisk(file: Pick<ChangedFile, 'chunks' | 'fileFindings'>): RiskLevel | null {
  let worst: RiskLevel | null = file.fileFindings.length === 0 ? null : levelOf(file.fileFindings)
  for (const chunk of file.chunks) {
    if (chunk.analysis === null) continue
    if (worst === null || RISK_RANK[chunk.analysis.riskLevel] < RISK_RANK[worst]) {
      worst = chunk.analysis.riskLevel
    }
  }
  return worst
}

/**
 * The changed files, from the diff and the board together: the diff knows a file's status and
 * size, the board knows its risk. A file the board has and the diff does not yet (the diff is
 * fetched, the board pushed, so either can be a moment ahead) is still listed.
 */
export function changedFiles(
  diff: DiffView | null,
  chunks: LiveChunk[],
  fileFindings: FileFindings[] = [],
): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  for (const file of diff?.files ?? []) {
    files.set(tabKey(file.root, file.path), {
      root: file.root,
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      kind: file.patch.kind,
      added: file.patch.addedCount,
      removed: file.patch.removedCount,
      chunks: [],
      fileFindings: [],
    })
  }
  for (const chunk of chunks) {
    const key = tabKey(chunk.root, chunk.path)
    const file = files.get(key) ?? {
      root: chunk.root,
      path: chunk.path,
      kind: chunk.kind,
      added: 0,
      removed: 0,
      chunks: [],
      fileFindings: [],
    }
    file.chunks.push(chunk)
    files.set(key, file)
  }
  for (const entry of fileFindings) {
    const file = files.get(tabKey(entry.root, entry.path))
    if (file !== undefined) file.fileFindings = entry.findings
  }

  return [...files.values()].sort(
    (a, b) => groupRank(a) - groupRank(b) || a.path.localeCompare(b.path),
  )
}

/** How a file's risk reads at a glance: a short badge, and the tone it is painted in. */
export type FileRisk = {
  /** `high` / `med` / `low` / `none`, or `—` for a file the review will never read. */
  badge: string
  tone: 'high' | 'med' | 'low' | 'none'
  /** Still being read, or queued to be — the badge shows a spinner instead of a word. */
  reading: boolean
  /** Why the whole file was skipped, trimmed to the reason itself ("generated or vendored"). */
  skipped: string | null
}

const BADGE: Record<RiskLevel, { badge: string; tone: FileRisk['tone'] }> = {
  high: { badge: 'high', tone: 'high' },
  medium: { badge: 'med', tone: 'med' },
  low: { badge: 'low', tone: 'low' },
  none: { badge: 'none', tone: 'none' },
}

/** `skipReason` says "path: reason"; next to the path already on screen, the reason is enough. */
function shortReason(reason: string | null): string {
  if (reason === null) return 'not analysed'
  const at = reason.lastIndexOf(': ')
  return at === -1 ? reason : reason.slice(at + 2)
}

export function fileRisk(file: ChangedFile): FileRisk {
  const worst = worstRisk(file)
  // A pending chunk with a reason had its check fail — nothing is reading it until the next
  // change, so it should not spin.
  const reading = file.chunks.some(
    (chunk) =>
      chunk.status === 'analyzing' || (chunk.status === 'pending' && chunk.reason === null),
  )
  const allSkipped =
    file.chunks.length > 0 && file.chunks.every((chunk) => chunk.status === 'skipped')
  if (allSkipped) {
    return {
      badge: '—',
      tone: 'none',
      reading: false,
      skipped: shortReason(file.chunks[0]?.reason ?? null),
    }
  }
  if (worst !== null) return { ...BADGE[worst], reading, skipped: null }
  return { badge: '—', tone: 'none', reading, skipped: null }
}

/** Where a path's name ends and its directory begins. */
function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/**
 * The rail's sections, in the order they are read. A file with no review yet sits right under
 * the ones with something wrong: it may turn out to be either, and until it does it is worth
 * more attention than a file already found to be fine.
 */
export type RailGroup = 'high' | 'medium' | 'unreviewed' | 'low' | 'none' | 'skipped'

const RAIL_GROUPS: RailGroup[] = ['high', 'medium', 'unreviewed', 'low', 'none', 'skipped']

const GROUP_LABEL: Record<RailGroup, string> = {
  high: 'high',
  medium: 'med',
  unreviewed: 'not reviewed yet',
  low: 'low',
  none: 'none',
  skipped: 'skipped',
}

/** Folded until opened: nothing in them is asking to be read. */
const FOLDED_BY_DEFAULT: ReadonlySet<RailGroup> = new Set(['low', 'none', 'skipped'])

export function railGroup(file: ChangedFile): RailGroup {
  const risk = fileRisk(file)
  if (risk.skipped !== null) return 'skipped'
  return worstRisk(file) ?? 'unreviewed'
}

/** `changedFiles`' order: the rail's sections top to bottom, then by path. */
function groupRank(file: ChangedFile): number {
  return RAIL_GROUPS.indexOf(railGroup(file))
}

/** What a changed file's dot says: the rail section it sits in, or that it was marked reviewed. */
export type FileMark = RailGroup | 'reviewed'

/**
 * Every changed file's mark, by path — what tints its dot in the project tree and on its tab.
 *
 * One function for both, so that the two surfaces can never disagree about what a file is:
 * a tab painted "high" beside a tree dot painted "reviewed" would be two answers to the same
 * question, and the reader has no way to tell which one is stale.
 */
export function marksByPath(files: ChangedFile[], reviewed: ChangedFile[]): Map<string, FileMark> {
  const reviewedPaths = new Set(reviewed.map((file) => file.path))
  return new Map(
    files.map((file) => [file.path, reviewedPaths.has(file.path) ? 'reviewed' : railGroup(file)]),
  )
}

/**
 * The left panel: the changed files, or — one switch away — every file in the project.
 *
 * "Changed" lists them in sections by what the review made of them, riskiest first. The quiet
 * sections start folded, and whichever one holds the file on screen opens itself. While the plan
 * is on screen no file row is selected. A file the reader has finished with can be marked
 * reviewed and moves to the folded "reviewed" section at the bottom; it comes back by itself
 * the next time it changes, or when the ↩ beside it there is pressed. Opening one from that
 * section only reads it — the mark is the reader's record of what they have read, and browsing
 * is not how it should come undone.
 *
 * "All files" is the project tree (`tree`, rendered by the caller). Both views stay mounted and
 * the one off screen is hidden, so each keeps its scroll, folds and filter across the switch.
 */
export function ReviewRail({
  files,
  hidden,
  annotations,
  plan,
  selected,
  planSelected,
  showAll,
  allCount,
  tree,
  onSelect,
  onSelectPlan,
  onHide,
  onShow,
  onShowAllChange,
  onCollapse,
}: {
  /** The files to list — every changed file not hidden. */
  files: ChangedFile[]
  /** Changed files the reader has marked reviewed. */
  hidden: ChangedFile[]
  annotations: Annotation[]
  /** The plan awaiting a decision, if there is one. Pinned above the files and not hideable:
   *  unlike a file, it is holding the agent up. */
  plan: PlanReviewState | null
  /** The file on screen, or null when the plan is on screen instead. */
  selected: { root: string; path: string } | null
  planSelected: boolean
  /** Whether "All files" is on screen rather than "Changed". */
  showAll: boolean
  /** How many files the project has, once listed. */
  allCount: number | null
  /** The "All files" view. */
  tree: ReactNode
  onSelect: (file: { root: string; path: string }) => void
  onSelectPlan: () => void
  onHide: (file: { root: string; path: string }) => void
  onShow: (file: { root: string; path: string }) => void
  onShowAllChange: (showAll: boolean) => void
  /** Fold the whole panel to its rail. */
  onCollapse: () => void
}) {
  const selectedRef = useRef<HTMLDivElement>(null)
  const [toggled, setToggled] = useState<ReadonlyMap<RailGroup | 'reviewed', boolean>>(new Map())

  const groups = RAIL_GROUPS.map((group) => ({
    group,
    files: files.filter((file) => railGroup(file) === group),
  })).filter((entry) => entry.files.length > 0)

  const selectedFile =
    selected === null
      ? undefined
      : files.find((file) => file.root === selected.root && file.path === selected.path)
  const selectedGroup = selectedFile === undefined ? null : railGroup(selectedFile)

  // The file on screen may sit in a folded section — open it, so what the reader is reading is
  // never somewhere they cannot see it.
  useEffect(() => {
    if (selectedGroup === null) return
    setToggled((was) =>
      was.get(selectedGroup) === true ? was : new Map(was).set(selectedGroup, true),
    )
  }, [selectedGroup])

  const isOpen = (group: RailGroup | 'reviewed'): boolean =>
    toggled.get(group) ?? (group !== 'reviewed' && !FOLDED_BY_DEFAULT.has(group))

  // That row may be scrolled out of the rail — bring it into view. The plan is in this too: it
  // is auto-selected on arrival.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is the trigger
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected?.root, selected?.path, planSelected, selectedGroup])

  // A plan arriving is holding the agent up, and it is pinned on the "Changed" side only —
  // so it brings that side back on screen.
  const planWaiting = plan !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a plan's arrival switches
  useEffect(() => {
    if (planWaiting) onShowAllChange(false)
  }, [planWaiting])

  const skipped = files.filter((file) => railGroup(file) === 'skipped').length
  const changedCount = files.length + hidden.length
  const count = showAll
    ? allCount === null
      ? null
      : `${allCount} ${allCount === 1 ? 'file' : 'files'} · ${changedCount} changed`
    : files.length === 0
      ? null
      : `${files.length} ${files.length === 1 ? 'file' : 'files'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`

  return (
    <aside className="review-rail">
      <div className="panel-head">
        <span className="lbl">files</span>
        {count !== null && <span className="review-rail-count">{count}</span>}
        <button
          type="button"
          className="panel-hide"
          title="Hide the files"
          aria-label="Hide the files"
          onClick={onCollapse}
        >
          <Chevron dir="left" />
        </button>
      </div>

      <div className="rail-switch" role="tablist" aria-label="Which files">
        <button
          type="button"
          role="tab"
          className="rail-switch-tab"
          aria-selected={!showAll}
          onClick={() => onShowAllChange(false)}
        >
          Changed <span className="rail-switch-count">{files.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="rail-switch-tab"
          aria-selected={showAll}
          title="Every file in the project (⌘K)"
          onClick={() => onShowAllChange(true)}
        >
          All files
          {allCount !== null && <span className="rail-switch-count">{allCount}</span>}
        </button>
      </div>

      <div className="rail-view" hidden={!showAll}>
        {tree}
        <div className="review-rail-foot rail-legend">
          <span>
            <span className="rail-legend-dot tree-dot-high" />
            high
          </span>
          <span>
            <span className="rail-legend-dot tree-dot-medium" />
            med
          </span>
          <span>
            <span className="rail-legend-dot tree-dot-none" />
            clean
          </span>
          <span>
            <span className="rail-legend-dot tree-dot-reviewed" />
            reviewed
          </span>
        </div>
      </div>

      <div className="rail-view" hidden={showAll}>
        {plan !== null && (
          // No ✓ beside it: a plan cannot be marked reviewed and set aside.
          <div ref={planSelected ? selectedRef : undefined} className="review-rail-plan-slot">
            <button
              type="button"
              className={`review-rail-plan${planSelected ? ' on' : ''}`}
              title="The agent has submitted a plan and is waiting on your decision"
              onClick={onSelectPlan}
            >
              <span className="review-rail-plan-mark">◆</span>
              <span className="review-rail-plan-name">the plan</span>
              {plan.notes.length > 0 && (
                <span
                  className="tab-notes"
                  title={`${plan.notes.length} ${plan.notes.length === 1 ? 'note' : 'notes'} on this plan`}
                >
                  <span className="tab-notes-dot" />
                  {plan.notes.length}
                </span>
              )}
              <span className="review-rail-plan-aside">waiting on you</span>
            </button>
          </div>
        )}

        <div className="review-rail-body">
          {files.length === 0 && (
            <p className="review-rail-empty">
              {hidden.length === 0
                ? 'Nothing has changed in this session yet.'
                : 'Every changed file has been reviewed.'}
            </p>
          )}
          {groups.map(({ group, files: members }) => {
            const open = isOpen(group)
            return (
              <section key={group} className="review-rail-group">
                <GroupHead
                  group={group}
                  label={GROUP_LABEL[group]}
                  count={members.length}
                  open={open}
                  onToggle={() => setToggled((was) => new Map(was).set(group, !open))}
                />
                {open &&
                  members.map((file) => {
                    const on = selected?.root === file.root && selected.path === file.path
                    return (
                      <RailRow
                        key={tabKey(file.root, file.path)}
                        ref={on ? selectedRef : undefined}
                        file={file}
                        on={on}
                        notes={unsentNotes(annotations, file)}
                        onSelect={onSelect}
                        onHide={onHide}
                      />
                    )
                  })}
              </section>
            )
          })}
          {hidden.length > 0 && (
            // Last, and folded until opened: the reader has already finished with these.
            <section className="review-rail-group">
              <GroupHead
                group="reviewed"
                label="reviewed"
                count={hidden.length}
                open={isOpen('reviewed')}
                onToggle={() =>
                  setToggled((was) => new Map(was).set('reviewed', !isOpen('reviewed')))
                }
              />
              {isOpen('reviewed') &&
                hidden.map((file) => (
                  <RailRow
                    key={tabKey(file.root, file.path)}
                    ref={
                      selected !== null &&
                      selected.root === file.root &&
                      selected.path === file.path
                        ? selectedRef
                        : undefined
                    }
                    file={file}
                    on={
                      selected !== null &&
                      selected.root === file.root &&
                      selected.path === file.path
                    }
                    notes={unsentNotes(annotations, file)}
                    onSelect={onSelect}
                    onShow={onShow}
                  />
                ))}
            </section>
          )}
        </div>

        <div className="review-rail-foot">
          <span className="review-rail-hint">⌘K to search</span>
        </div>
      </div>
    </aside>
  )
}

/** A section's heading: its label, how many files it holds, and whether it is folded. */
function GroupHead({
  group,
  label,
  count,
  open,
  onToggle,
}: {
  group: RailGroup | 'reviewed'
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={`review-rail-group-head group-${group}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="review-rail-group-label">{label}</span>
      <span className="review-rail-group-count">{count}</span>
      <span className="review-rail-group-rule" />
      <span className="review-rail-group-caret">{open ? '▾' : '▸'}</span>
    </button>
  )
}

/** How many notes on this file are still waiting to be sent — what its row counts. */
function unsentNotes(annotations: Annotation[], file: ChangedFile): number {
  return annotations.filter(
    (note) => note.sentAt === null && note.root === file.root && note.path === file.path,
  ).length
}

/**
 * One changed file: its name over its directory, and on the right what matters most about it —
 * unsent notes if there are any, a spinner while it is read, its size otherwise. Two buttons side
 * by side rather than one inside the other, which HTML forbids.
 *
 * **Opening a file never changes its reviewed mark.** A reviewed file used to come back to the
 * list simply by being clicked, which made reading one destructive: there was no way to look at
 * what you had already read without un-reviewing it, and the marks quietly came undone as the
 * reader browsed. The second button says which way this row can move — ✓ to mark it reviewed,
 * ↩ to take that back — and it is the only thing that moves it.
 */
function RailRow({
  ref,
  file,
  on,
  notes,
  onSelect,
  onHide,
  onShow,
}: {
  ref: Ref<HTMLDivElement> | undefined
  file: ChangedFile
  on: boolean
  notes: number
  onSelect: (file: { root: string; path: string }) => void
  /** Absent for a file already marked reviewed: it is `onShow` that such a row offers. */
  onHide?: (file: { root: string; path: string }) => void
  /** Present only for a file already marked reviewed — the mark, taken back. */
  onShow?: (file: { root: string; path: string }) => void
}) {
  const risk = fileRisk(file)
  const { name, dir } = splitPath(file.path)
  const sub = [dir, risk.skipped].filter((part) => part !== null && part !== '').join(' · ')
  return (
    <div ref={ref} className={`rail-row${on ? ' on' : ''}`}>
      <button
        type="button"
        className="rail-row-open"
        title={
          file.previousPath === undefined ? file.path : `${file.path} (from ${file.previousPath})`
        }
        onClick={() => onSelect({ root: file.root, path: file.path })}
      >
        <span className="rail-row-text">
          <span className="rail-row-name">{name}</span>
          {sub !== '' && <span className="rail-row-dir">{sub}</span>}
        </span>
        {notes > 0 ? (
          <span className="tab-notes" title={`${notes} unsent ${notes === 1 ? 'note' : 'notes'}`}>
            <span className="tab-notes-dot" />
            {notes}
          </span>
        ) : risk.reading ? (
          <span className="spinner spinner-inline" title="Being reviewed" aria-hidden="true" />
        ) : (
          <span className="rail-row-delta">
            +{file.added} −{file.removed}
          </span>
        )}
      </button>
      {onHide !== undefined && (
        <button
          type="button"
          className="rail-row-hide"
          title="Mark reviewed — it comes back when it changes again"
          aria-label={`Mark ${file.path} reviewed`}
          onClick={() => onHide({ root: file.root, path: file.path })}
        >
          ✓
        </button>
      )}
      {onShow !== undefined && (
        <button
          type="button"
          className="rail-row-hide"
          title="Not reviewed after all — put it back in the list"
          aria-label={`Unmark ${file.path} as reviewed`}
          onClick={() => onShow({ root: file.root, path: file.path })}
        >
          ↩
        </button>
      )}
    </div>
  )
}

/**
 * Notes on files the rail does not list — ones left on a file the agent never touched, or on
 * one whose change it reverted. Without a home of their own they would be invisible, and still
 * sendable. Each opens its file, so the note can be read where it was written.
 */
export function OrphanedNotes({
  notes,
  onRemove,
  onOpen,
}: {
  notes: Annotation[]
  onRemove: (id: string) => void
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (notes.length === 0) return null

  return (
    <section className="group stale-notes">
      <button type="button" className="group-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="group-label">Notes on other files</span>
        <span className="count">{notes.length}</span>
      </button>

      {open &&
        notes.map((note) => (
          <div className="stale-note" key={note.id}>
            <div className="stale-where">
              <button type="button" className="stale-open" onClick={() => onOpen(note.path)}>
                {note.path}:{note.line}
              </button>
              <span className={`stale-state ${note.sentAt === null ? 'pending' : ''}`}>
                {note.sentAt === null ? 'not sent yet' : 'sent'}
              </span>
            </div>
            <div className="stale-body">{note.body}</div>
            <code className="stale-line">{note.lineText.trim()}</code>
            {note.sentAt === null && (
              <button type="button" className="note-remove" onClick={() => onRemove(note.id)}>
                remove
              </button>
            )}
          </div>
        ))}
    </section>
  )
}
