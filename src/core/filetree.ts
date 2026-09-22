/**
 * A flat list of repo-relative file paths, reshaped into the tree a file browser renders.
 *
 * Lives in `core` rather than the UI because it is pure — no I/O, no DOM — and testable the
 * same way the rest of the domain logic is. `adapters/web/ui` is the only consumer today.
 */

export type FileTreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'dir'; name: string; path: string; children: FileTreeNode[] }

/**
 * Builds a nested tree from a flat list of paths (as `ProjectTree.list()` returns), in one
 * call — no lazy per-directory fetching. The whole tree is available immediately, so
 * expand/collapse in the UI is instant client-side state.
 *
 * Directories sort before files; both alphabetically within their own group, at every level.
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const dirs = new Map<string, Extract<FileTreeNode, { kind: 'dir' }>>()

  for (const path of paths) {
    const segments = path.split('/')
    let siblings = root
    let prefix = ''

    segments.forEach((name, index) => {
      prefix = prefix === '' ? name : `${prefix}/${name}`
      const isLast = index === segments.length - 1

      if (isLast) {
        siblings.push({ kind: 'file', name, path: prefix })
        return
      }

      let dir = dirs.get(prefix)
      if (dir === undefined) {
        dir = { kind: 'dir', name, path: prefix, children: [] }
        dirs.set(prefix, dir)
        siblings.push(dir)
      }
      siblings = dir.children
    })
  }

  const sorted = (nodes: FileTreeNode[]): FileTreeNode[] =>
    [...nodes]
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      )
      .map((node) => (node.kind === 'dir' ? { ...node, children: sorted(node.children) } : node))

  return sorted(root)
}
