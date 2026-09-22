import { globby } from 'globby'
import type { GrepMatch, RepoReader } from '../../core/ports.ts'
import { readInside } from './safePath.ts'

/**
 * The reviewer's read-only window on the repository: read a file, list files by glob, search by
 * regex. The same file set as the explorer (`projectTree.ts`) — gitignore respected, `.git`
 * excluded at every depth, symlinks never followed — and every read goes through `readInside`,
 * so a model cannot be talked into reading outside the repository.
 *
 * Everything is capped. The results go straight into a model's context, and an unbounded grep
 * over a large repository is a way to spend a review's whole budget on one careless query.
 */

export const MAX_GLOB_PATHS = 200
export const MAX_GREP_MATCHES = 50
/** A file bigger than this is not searched — it is almost certainly generated or data. */
const MAX_GREP_FILE_BYTES = 512 * 1024
/** A matching line is cut to this, so a minified line cannot flood the result. */
const MAX_MATCH_CHARS = 240

function list(root: string, pattern: string): Promise<string[]> {
  return globby([pattern], {
    cwd: root,
    gitignore: true,
    onlyFiles: true,
    dot: true,
    ignore: ['**/.git'],
    followSymbolicLinks: false,
  })
}

export function createRepoReader(): RepoReader {
  return {
    read: (root, path) => readInside(root, path),

    glob: async (root, pattern) => {
      try {
        const paths = (await list(root, pattern)).sort()
        return { paths: paths.slice(0, MAX_GLOB_PATHS), truncated: paths.length > MAX_GLOB_PATHS }
      } catch {
        return { paths: [], truncated: false }
      }
    },

    grep: async (root, pattern, glob) => {
      let expression: RegExp
      try {
        expression = new RegExp(pattern)
      } catch {
        throw new Error(`Invalid regular expression: ${pattern}`)
      }

      const paths = (await list(root, glob ?? '**/*').catch(() => [])).sort()
      const matches: GrepMatch[] = []
      for (const path of paths) {
        const file = Bun.file(`${root}/${path}`)
        if (file.size > MAX_GREP_FILE_BYTES) continue
        const text = await readInside(root, path)
        if (text === null || text.includes('\0')) continue

        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ''
          if (!expression.test(line)) continue
          if (matches.length === MAX_GREP_MATCHES) return { matches, truncated: true }
          matches.push({ path, line: i + 1, text: line.slice(0, MAX_MATCH_CHARS) })
        }
      }
      return { matches, truncated: false }
    },
  }
}
