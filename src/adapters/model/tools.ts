import { tool } from 'ai'
import { z } from 'zod'
import { numbered } from '../../core/numbering.ts'
import type { RepoReader } from '../../core/ports.ts'

/**
 * The read-only tools both model agents get: read a file, list by glob, search by regex.
 *
 * Shared so that "what a model of ours may do to a repository" has one answer in one place.
 * There is no write tool here to withhold — the reviewer and the asker are read-only by
 * construction, not by a deny-list that could be forgotten. Every result is capped by the
 * `RepoReader` itself, so a careless query costs a truncated answer rather than an enormous
 * prompt.
 */

/** Lines of a file shown per read, so one call cannot fill the context. */
const MAX_READ_LINES = 400

export function readOnlyTools(reader: RepoReader, root: string) {
  return {
    read_file: tool({
      description: `Read a file in the repository, with line numbers. At most ${MAX_READ_LINES} lines per call.`,
      inputSchema: z.object({
        path: z.string().describe('Relative to the repository root.'),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: async ({ path, startLine, endLine }) => {
        const text = await reader.read(root, path)
        if (text === null) return `No such file: ${path}`
        const from = startLine ?? 1
        const to = Math.min(endLine ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1)
        const total = text.split('\n').length
        const more = to < total ? `\n… (${total} lines in all)` : ''
        return `${numbered(text, from, to)}${more}`
      },
    }),
    glob: tool({
      description: 'List repository files matching a glob, e.g. "src/**/*.test.ts".',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        const { paths, truncated } = await reader.glob(root, pattern)
        if (paths.length === 0) return 'No files match.'
        return `${paths.join('\n')}${truncated ? '\n… (more not shown)' : ''}`
      },
    }),
    grep: tool({
      description:
        'Search repository files by JavaScript regular expression, line by line. Optionally limit to files matching a glob.',
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional() }),
      execute: async ({ pattern, glob }) => {
        try {
          const { matches, truncated } = await reader.grep(root, pattern, glob)
          if (matches.length === 0) return 'No matches.'
          const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`)
          return `${lines.join('\n')}${truncated ? '\n… (more not shown)' : ''}`
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    }),
  }
}
