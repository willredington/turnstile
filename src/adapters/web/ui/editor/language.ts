import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'

/**
 * The CodeMirror grammar for a language id from `core/language.ts`.
 *
 * Keyed on the same ids `pathToLanguage` returns, so the curated set has exactly one home:
 * add an extension there and `editorLanguage.test.ts` fails until a grammar is named here.
 *
 * Unlike the Shiki highlighter this replaces, these parse *incrementally* — a keystroke
 * reparses the region it touched rather than the whole file, which is the difference between
 * a file that can be edited and one that can only be read.
 *
 * An unknown id returns null, which the editor treats as "render as plain text" — never an
 * error, and never a reason to hide content.
 */
const GRAMMARS: Record<string, () => Extension> = {
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  rust: () => rust(),
  python: () => python(),
  go: () => go(),
  json: () => json(),
  yaml: () => yaml(),
  css: () => css(),
  html: () => html(),
  markdown: () => markdown(),
  sql: () => sql(),
  toml: () => StreamLanguage.define(toml),
  bash: () => StreamLanguage.define(shell),
}

export function languageFor(language: string | null): Extension | null {
  if (language === null) return null
  const grammar = GRAMMARS[language]
  return grammar === undefined ? null : grammar()
}
