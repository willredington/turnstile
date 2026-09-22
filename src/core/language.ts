/**
 * Maps a file path to the Shiki language id used to syntax-highlight it, for the curated,
 * statically-bundled set of grammars `adapters/web/ui/highlight.ts` registers. Lives in `core`
 * rather than the UI because it is pure — no I/O — and testable the same way the rest of the
 * domain logic is, same reasoning as `buildFileTree` in `core/filetree.ts`.
 *
 * An extension outside this table returns `null`, which callers treat as "render as plain
 * text" — never an error, and never a reason to hide content.
 */

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  rs: 'rust',
  py: 'python',
  pyw: 'python',
  go: 'go',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
}

export const CURATED_LANGUAGES: readonly string[] = [
  ...new Set(Object.values(EXTENSION_TO_LANGUAGE)),
]

export function pathToLanguage(path: string): string | null {
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return EXTENSION_TO_LANGUAGE[extension] ?? null
}
