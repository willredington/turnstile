import { useEffect, useMemo, useRef, useState } from 'react'
import { buildFileTree, type FileTreeNode } from '../../../core/filetree.ts'
import type { Annotation } from '../../../core/types.ts'
import { type ChangedFile, type FileMark, marksByPath, OrphanedNotes } from './ChangedFiles.tsx'

/** Every directory above a path — what has to be open for that path to be on screen. */
function ancestors(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * Every path in the project, refetched whenever the working tree moved — a file the agent just
 * created or deleted belongs in the tree immediately. Null while loading, `'error'` if the list
 * could not be fetched.
 */
export function useProjectPaths(diffRevision: number): string[] | null | 'error' {
  const [paths, setPaths] = useState<string[] | null | 'error'>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRevision is a refetch signal
  useEffect(() => {
    let live = true
    void fetch('/files')
      .then((response) => {
        if (!response.ok) throw new Error('failed to list files')
        return response.json() as Promise<string[]>
      })
      .then((next) => {
        if (live) setPaths(next)
      })
      .catch(() => {
        if (live) setPaths('error')
      })
    return () => {
      live = false
    }
  }, [diffRevision])
  return paths
}

/**
 * The whole project, read-only — everything in the tree, not just what the session changed. It
 * is the left panel's "All files" view, beside the changed files. A changed file carries a dot
 * tinted by the section it sits in on the "Changed" side (or as reviewed), and the folders above every changed
 * file start open, so the tree says where the work is before anything is clicked.
 *
 * Kept mounted while the other view is on screen, so the filter and the folders the reader
 * opened are still there when they come back.
 *
 * Selecting a file hands its path up rather than deciding anything here: whether that path is
 * one of the changed files or is read as plain context is the caller's call.
 */
export function ProjectTree({
  paths,
  onShow,
  files,
  reviewed,
  orphanedNotes,
  onRemoveNote,
  selectedPath,
  onOpenFile,
}: {
  paths: string[] | null | 'error'
  /** Brings this view on screen — ⌘K does, from anywhere. */
  onShow: () => void
  /** Every changed file, reviewed or not, marked in the tree. */
  files: ChangedFile[]
  /** The changed files the reader has marked reviewed — marked as that instead of their risk. */
  reviewed: ChangedFile[]
  orphanedNotes: Annotation[]
  onRemoveNote: (id: string) => void
  /** The path open in the main column, changed or not. */
  selectedPath: string | null
  onOpenFile: (path: string) => void
}) {
  // The reader's own toggles, over the default of "open above a changed file".
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [filter, setFilter] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K shows this view (if the changed files are on screen) and focuses its filter either way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        onShow()
        requestAnimationFrame(() => {
          searchRef.current?.focus()
          searchRef.current?.select()
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onShow])

  const groupByPath = useMemo(() => marksByPath(files, reviewed), [files, reviewed])
  const openByDefault = useMemo(
    () => new Set(files.flatMap((file) => ancestors(file.path))),
    [files],
  )

  const listed = Array.isArray(paths) ? paths : null
  const query = filter.trim().toLowerCase()
  const filteredPaths = useMemo(
    () =>
      listed === null || query === ''
        ? listed
        : listed.filter((path) => path.toLowerCase().includes(query)),
    [listed, query],
  )
  const tree = useMemo(() => buildFileTree(filteredPaths ?? []), [filteredPaths])

  // Filtering opens everything, so a match is never hidden inside a closed folder.
  const isOpen = (dir: string): boolean =>
    query !== '' || (toggled.get(dir) ?? openByDefault.has(dir))

  return (
    <>
      <div className="files-panel-search">
        <input
          ref={searchRef}
          className="input"
          type="text"
          value={filter}
          placeholder="Filter files"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setFilter('')
              event.currentTarget.blur()
            }
          }}
        />
        <kbd>⌘K</kbd>
      </div>

      <div className="files-panel-body">
        {paths === 'error' && <p className="placeholder">Couldn't list files.</p>}
        {paths === null && <p className="placeholder">Loading…</p>}
        {listed !== null && filteredPaths?.length === 0 && (
          <p className="placeholder">Nothing matches.</p>
        )}
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            isOpen={isOpen}
            selected={selectedPath}
            groupByPath={groupByPath}
            onToggle={(path) => setToggled((was) => new Map(was).set(path, !isOpen(path)))}
            onOpenFile={onOpenFile}
          />
        ))}

        <OrphanedNotes notes={orphanedNotes} onRemove={onRemoveNote} onOpen={onOpenFile} />
      </div>
    </>
  )
}

function TreeRow({
  node,
  depth,
  isOpen,
  selected,
  groupByPath,
  onToggle,
  onOpenFile,
}: {
  node: FileTreeNode
  depth: number
  isOpen: (dir: string) => boolean
  selected: string | null
  groupByPath: Map<string, FileMark>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const indent = { paddingLeft: `${12 + depth * 16}px` }

  if (node.kind === 'file') {
    const group = groupByPath.get(node.path)
    return (
      <button
        type="button"
        title={node.path}
        className={`tree tree-file${group === undefined ? '' : ' changed'}${
          selected === node.path ? ' on' : ''
        }`}
        style={indent}
        onClick={() => onOpenFile(node.path)}
      >
        <span className="tree-name">{node.name}</span>
        {group !== undefined && <span className={`tree-dot tree-dot-${group}`} />}
      </button>
    )
  }

  const open = isOpen(node.path)
  return (
    <>
      <button
        type="button"
        className="tree tree-dir"
        style={indent}
        onClick={() => onToggle(node.path)}
      >
        <span className="tree-caret">{open ? '▾' : '▸'}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            isOpen={isOpen}
            selected={selected}
            groupByPath={groupByPath}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}
