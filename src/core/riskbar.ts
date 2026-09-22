import type { RiskBarConfig } from './config.ts'

/**
 * Only the parts of the risk-bar config this module actually reads.
 *
 * The advisor setting lives alongside these but is the gate's business, not the
 * classifier's — and a pure function that cannot see a model setting cannot accidentally
 * grow to depend on one.
 */
type Globs = Pick<RiskBarConfig, 'alwaysReview' | 'neverReview' | 'specPaths'>

import type { FileDelta } from './types.ts'

/**
 * The risk bar decides whether a turn earns a gate at all.
 *
 * This is the single most important thing standing between Turnstile and the fate of every
 * review tool that gets disabled: nagging on Q&A turns and formatting passes. The bar
 * mirrors Claude Code's auto-mode intuition — flag changes that alter behavior, logic,
 * interfaces, dependencies, or config; let formatting, whitespace, comments, docs, and
 * mechanical renames pass silently.
 *
 * Deliberately a pure function with no model call: the classifier runs on every turn,
 * including the many that change nothing, and a gate that costs a model round-trip to
 * decide it isn't needed is a gate nobody keeps.
 *
 * Every heuristic here errs toward gating. A false gate costs one review; a false pass
 * is drift, which is the thing this tool exists to prevent.
 */

const DOC_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc'])
const DOC_BASENAMES = new Set([
  'license',
  'licence',
  'notice',
  'authors',
  'contributors',
  'changelog',
])
const DOC_DIRECTORIES = ['docs/', 'doc/']

/**
 * Line-comment syntax by extension. Used only to answer "is every changed line a
 * comment?", so an unrecognized extension is treated as code and gates.
 */
const LINE_COMMENTS: Record<string, string[]> = {
  ts: ['//'],
  tsx: ['//'],
  js: ['//'],
  jsx: ['//'],
  mjs: ['//'],
  cjs: ['//'],
  java: ['//'],
  kt: ['//'],
  swift: ['//'],
  go: ['//'],
  rs: ['//'],
  c: ['//'],
  h: ['//'],
  cpp: ['//'],
  hpp: ['//'],
  cc: ['//'],
  cs: ['//'],
  php: ['//', '#'],
  scala: ['//'],
  dart: ['//'],
  zig: ['//'],
  py: ['#'],
  rb: ['#'],
  sh: ['#'],
  bash: ['#'],
  zsh: ['#'],
  fish: ['#'],
  yml: ['#'],
  yaml: ['#'],
  toml: ['#'],
  r: ['#'],
  pl: ['#'],
  ex: ['#'],
  exs: ['#'],
  sql: ['--'],
  lua: ['--'],
  hs: ['--'],
  elm: ['--'],
  clj: [';'],
  el: [';'],
  lisp: [';'],
}

/** Block-comment delimiters, keyed by extension. */
const BLOCK_COMMENTS: Record<string, [string, string][]> = {
  ts: [['/*', '*/']],
  tsx: [['/*', '*/']],
  js: [['/*', '*/']],
  jsx: [['/*', '*/']],
  mjs: [['/*', '*/']],
  cjs: [['/*', '*/']],
  java: [['/*', '*/']],
  kt: [['/*', '*/']],
  go: [['/*', '*/']],
  rs: [['/*', '*/']],
  c: [['/*', '*/']],
  h: [['/*', '*/']],
  cpp: [['/*', '*/']],
  hpp: [['/*', '*/']],
  cc: [['/*', '*/']],
  cs: [['/*', '*/']],
  css: [['/*', '*/']],
  scss: [['/*', '*/']],
  less: [['/*', '*/']],
  php: [['/*', '*/']],
  scala: [['/*', '*/']],
  swift: [['/*', '*/']],
  dart: [['/*', '*/']],
  html: [['<!--', '-->']],
  xml: [['<!--', '-->']],
  vue: [['<!--', '-->']],
}

export function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const dot = basename.lastIndexOf('.')
  return dot <= 0 ? '' : basename.slice(dot + 1).toLowerCase()
}

/**
 * A path the user has named as a spec/plan document — one worth a human's eyes, not the
 * ordinary doc-path skip. See `RiskBarConfigSchema.specPaths`.
 */
export function isSpecPath(path: string, specPaths: readonly string[]): boolean {
  return specPaths.some((pattern) => matchesGlob(path, pattern))
}

export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase()
  if (DOC_DIRECTORIES.some((dir) => lower.startsWith(dir))) return true

  const basename = lower.slice(lower.lastIndexOf('/') + 1)
  const extension = extensionOf(lower)
  if (extension !== '' && DOC_EXTENSIONS.has(extension)) return true

  // LICENSE, CHANGELOG and friends carry no extension.
  const stem =
    extension === '' ? basename : basename.slice(0, basename.length - extension.length - 1)
  return DOC_BASENAMES.has(stem)
}

/**
 * Languages where leading whitespace carries meaning. Reindenting Python or YAML is a
 * behavior change, not a reformat, so these get a stricter comparison.
 */
const INDENT_SIGNIFICANT = new Set([
  'py',
  'pyi',
  'yml',
  'yaml',
  'sass',
  'haml',
  'slim',
  'coffee',
  'nim',
  'jade',
  'pug',
])

/**
 * True when the added and removed lines carry the same content modulo whitespace — a
 * reformat.
 *
 * For most languages this means stripping whitespace entirely and comparing, so a
 * reflow that moves content between lines still reads as formatting. For
 * indent-significant languages it does not: there, leading whitespace is program
 * meaning, so only trailing and internal runs are normalized and a reindent gates.
 */
export function isWhitespaceOnly(delta: FileDelta): boolean {
  if (delta.addedLines.length === 0 || delta.removedLines.length === 0) return false

  const normalize = INDENT_SIGNIFICANT.has(extensionOf(delta.path))
    ? (lines: string[]): string =>
        lines
          .map((line) => {
            const indent = line.length - line.trimStart().length
            return `${' '.repeat(indent)}${line.trim().replace(/\s+/g, ' ')}`
          })
          .join('\n')
    : (lines: string[]): string => lines.join('').replace(/\s+/g, '')

  return normalize(delta.addedLines) === normalize(delta.removedLines)
}

/**
 * Whether one changed line is a comment or blank.
 *
 * Line-by-line detection cannot track block-comment state or tell a `//` inside a
 * string literal from a real comment, so the block-comment rules stay deliberately
 * tight: a self-contained block, a JSDoc continuation (`*` followed by space or end of
 * line — never `*ptr`), or a bare closing delimiter.
 */
function isCommentLine(line: string, extension: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true

  for (const prefix of LINE_COMMENTS[extension] ?? []) {
    if (trimmed.startsWith(prefix)) return true
  }

  for (const [open, close] of BLOCK_COMMENTS[extension] ?? []) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) return true
    if (trimmed === close) return true
    if (trimmed.startsWith(open)) return true
    if (/^\*(\s|$)/.test(trimmed)) return true
  }

  return false
}

/**
 * True when every changed line is a comment or blank. Requires known comment syntax:
 * an unrecognized extension returns false and the file gates.
 */
export function isCommentOnly(delta: FileDelta): boolean {
  const extension = extensionOf(delta.path)
  if (!(extension in LINE_COMMENTS) && !(extension in BLOCK_COMMENTS)) return false

  const changed = [...delta.addedLines, ...delta.removedLines]
  if (changed.length === 0) return false

  return changed.every((line) => isCommentLine(line, extension))
}

/**
 * Minimal glob matching: `*` within a path segment, `**` across segments. Enough for
 * the alwaysReview / neverReview escape hatches without taking a dependency.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  // Scanned in one pass rather than by chained replaces through placeholder sentinels:
  // a sentinel has to be a string that cannot appear in a real pattern, and every
  // choice of sentinel is a latent collision waiting for the input that contains it.
  let expression = ''

  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]

    if (character === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` spans any number of leading directories, including none.
          expression += '(?:.*/)?'
          i += 2
        } else {
          expression += '.*'
          i += 1
        }
      } else {
        expression += '[^/]*'
      }
      continue
    }

    if (character === '?') {
      expression += '[^/]'
      continue
    }

    expression += character?.replace(/[.+^${}()|[\]\\]/g, '\\$&') ?? ''
  }

  return new RegExp(`^${expression}$`).test(path)
}

/**
 * Paths whose contents no human reviews line by line, so gating on them is pure nagging.
 *
 * Lockfiles are the motivating case. They are worth stating why they are safe to pass: a
 * lockfile only ever moves because a manifest moved or an install ran, and the manifest —
 * `package.json`, `Cargo.toml` — is a dependency change that gates on its own. Passing the
 * lockfile therefore hides nothing; it just stops the review being 4,000 lines of resolved
 * versions wrapped around the one line that actually changed.
 *
 * The residual risk is a lockfile edited *without* its manifest — a redirected registry or
 * a swapped integrity hash. That is a supply-chain concern rather than a code-review one,
 * and anyone who wants it gated can name it in `alwaysReview`, which outranks this list.
 *
 * Always applied, and user `neverReview` extends rather than replaces it: nobody should
 * have to re-list every lockfile in existence in order to add one glob of their own.
 */
const GENERATED_PATHS = [
  '**/bun.lock',
  '**/bun.lockb',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/*.snap',
  'node_modules/**',
  'vendor/**',
  '**/dist/**',
  '**/.next/**',
]

/**
 * Per-file classification. Returns the reason a file is not worth a risk check, or null when
 * it is.
 *
 * The semantic layer in front of every model call: the reason it gives is what the reader sees
 * in place of an analysis, so it has to be a sentence, not a boolean.
 */
export function skipReason(delta: FileDelta, config: Globs): string | null {
  // alwaysReview wins every tie: it is the user saying they do not trust the heuristic
  // for this path, and they outrank it.
  if (config.alwaysReview.some((pattern) => matchesGlob(delta.path, pattern))) return null

  // A spec path outranks the documentation skip below for the same reason alwaysReview
  // outranks everything: the user named this path as worth a human before a model heuristic
  // gets a vote.
  if (isSpecPath(delta.path, config.specPaths)) return null

  if (GENERATED_PATHS.some((pattern) => matchesGlob(delta.path, pattern))) {
    return `${delta.path}: generated or vendored`
  }
  if (config.neverReview.some((pattern) => matchesGlob(delta.path, pattern))) {
    return `${delta.path}: matches neverReview`
  }

  // A changed binary is opaque to every check below, so it is not skipped. An image swap is
  // rarely interesting; a replaced compiled artifact very much is.
  if (delta.binary) return null

  if (delta.pureRename) return `${delta.path}: mechanical rename`
  if (isDocPath(delta.path)) return `${delta.path}: documentation`
  if (isWhitespaceOnly(delta)) return `${delta.path}: whitespace/formatting only`
  if (isCommentOnly(delta)) return `${delta.path}: comments only`

  return null
}

/**
 * Every file beneath the bar, by path, with the reason.
 *
 * The map is how the rest of the pipeline applies one decision consistently: the board and
 * the background pass ask the same question of the same deltas, so a file cannot be skipped in
 * one place and analysed in another.
 */
export function skipReasons(deltas: FileDelta[], config: Globs): Map<string, string> {
  const skips = new Map<string, string>()
  for (const delta of deltas) {
    const reason = skipReason(delta, config)
    if (reason !== null) skips.set(delta.path, reason)
  }
  return skips
}
