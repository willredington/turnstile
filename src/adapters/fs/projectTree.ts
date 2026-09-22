import { globby } from 'globby'
import { looksBinary } from '../../core/binary.ts'
import type { FileContents, ProjectTree } from '../../core/ports.ts'
import { readBytesInside } from './safePath.ts'

/**
 * Every file across every root the session knows about, respecting `.gitignore` — including
 * nested ones, which is what `globby`'s `gitignore` option buys over hand-rolled
 * ignore-pattern matching. `.git` is excluded explicitly, at every depth: it isn't itself
 * expressed by any `.gitignore` rule, and a nested `.git` (a submodule, or a worktree under
 * `.claude/worktrees/`) is exactly as sensitive as the root one. Symlinks are never followed,
 * so a link inside a root pointing outside it can't be used to walk `list()`/`read()` past
 * that root.
 *
 * No bound `cwd`: `root` is passed per call, the same way `EditTarget` takes it, so one
 * instance serves whichever root is live rather than needing a fresh instance per session.
 */
export function createProjectTree(): ProjectTree {
  return {
    list: (root) =>
      globby(['**/*'], {
        cwd: root,
        gitignore: true,
        onlyFiles: true,
        // fast-glob's default matching excludes dotfiles/dot-directories — without this, a
        // real file browser would silently hide .gitignore, .env, .github/, etc.
        dot: true,
        // `**/.git` (not the bare `.git`) so a nested `.git` — a submodule, or (as in this
        // repo) `.claude/worktrees/<name>/.git` — is pruned too, not just a root-level one.
        ignore: ['**/.git'],
        // Never follow a symlink out of the root. Without this, `list()` (and, since `read()`
        // only refuses paths that resolve outside `root`, `read()` too) can surface files
        // that live entirely outside it — see `safePath.ts`'s `readInside` for the matching
        // defense on the read side.
        followSymbolicLinks: false,
      }),

    // Read as bytes and classify before decoding: a binary file's contents are never handed
    // out, because every surface that renders a file renders it line by line and a binary
    // file has no lines — only a few enormous ones that freeze the app laying them out.
    read: async (root, path): Promise<FileContents | null> => {
      const bytes = await readBytesInside(root, path)
      if (bytes === null) return null
      if (looksBinary(bytes)) return { kind: 'binary' }
      return { kind: 'text', text: new TextDecoder().decode(bytes) }
    },
  }
}
