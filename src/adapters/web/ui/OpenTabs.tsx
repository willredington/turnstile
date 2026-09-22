import { useEffect, useRef } from 'react'
import type { FileMark } from './ChangedFiles.tsx'

/**
 * Every file the reader has open, as a strip of tabs across the top — pulled up from the
 * project tree, or clicked in the review rail, with no distinction drawn between the two. What
 * is open is where the reader is, and that is one question with one answer.
 *
 * Deliberately not a mode of `ReviewRail`. That rail answers "what has the agent changed, and
 * what did the review make of it" — a risk badge, a skip reason, unsent notes, a ✓ that puts a
 * file away until it changes again. This one answers "what have I got open", which is a name, a
 * colour, and a way to close it. Folding the two together would mean a component whose props are
 * mostly absent at each of its two call sites; the part worth sharing is the stylesheet, and
 * that is shared already.
 *
 * The colour is the rail's own, through `marksByPath`: a tab carries the same dot the project
 * tree gives the same file, so "high" and "reviewed" mean one thing wherever they are painted.
 * A file that is not on the board carries no dot — there is nothing for the review to say
 * about a file the agent never touched.
 */

/** The file's name without its directories — a tab has room for nothing more. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function OpenTabs({
  paths,
  marks,
  selected,
  onSelect,
  onClose,
}: {
  /** The files the reader has open, in the order they were opened. */
  paths: string[]
  /** How each changed file is tinted, by path. A path absent from it is not on the board. */
  marks: ReadonlyMap<string, FileMark>
  /** Which of them is on screen, or null when the plan is. */
  selected: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  const selectedRef = useRef<HTMLDivElement>(null)
  // A tab can be scrolled out of the strip — bring the open one into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is the trigger
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <nav className="file-tabs open-tabs">
      <div className="file-tabs-scroll">
        {paths.map((path) => {
          const on = selected === path
          const mark = marks.get(path)
          return (
            // Two buttons side by side rather than one inside the other, which HTML forbids.
            <div key={path} ref={on ? selectedRef : undefined} className={`tab${on ? ' on' : ''}`}>
              <button
                type="button"
                className="tab-open"
                title={path}
                onClick={() => onSelect(path)}
              >
                <span className="tab-name">{basename(path)}</span>
                {mark !== undefined && <span className={`tree-dot tree-dot-${mark}`} />}
              </button>
              <button
                type="button"
                className="tab-close"
                title="Close"
                aria-label={`Close ${path}`}
                onClick={() => onClose(path)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
