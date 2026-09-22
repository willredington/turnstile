import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { typescriptLanguage } from '@codemirror/lang-javascript'
import { highlightTree } from '@lezer/highlight'
import { codeHighlight } from '../../../../src/adapters/web/ui/editor/highlight.ts'

const STYLES = new URL('../../../../src/adapters/web/ui/styles.css', import.meta.url)

/** The ground the editor actually sits on, read from the stylesheet so it cannot drift. */
function editorBackground(): string {
  const match = /--color-bg:\s*(#[0-9a-f]{6})/i.exec(readFileSync(STYLES, 'utf8'))
  if (match === null) throw new Error('styles.css no longer defines --color-bg as a hex colour')
  return match[1] as string
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return (
    0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number)
  )
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** Every class `highlightTree` hands back for a snippet, keyed by the text it covered. */
function classesFor(code: string): Map<string, string> {
  const tree = typescriptLanguage.parser.parse(code)
  const found = new Map<string, string>()
  highlightTree(tree, codeHighlight, (from, to, cls) => {
    found.set(code.slice(from, to), cls)
  })
  return found
}

describe('codeHighlight', () => {
  /**
   * The reason this theme replaced the hand-mapped one. One Dark is designed for its own
   * lighter `#282c34`, so on Turnstile's darker ground it has margin to spare — but a future
   * theme swap, or a lighter `--color-bg`, could quietly spend it.
   */
  test('every colour clears WCAG AA against the ground the editor sits on', () => {
    const background = editorBackground()
    const dim = codeHighlight.specs
      .map((spec) => (spec as { color?: string }).color)
      .filter((color): color is string => color !== undefined && /^#[0-9a-f]{6}$/i.test(color))
      .map((color) => ({ color, ratio: Number(contrast(color, background).toFixed(2)) }))
      .filter((measured) => measured.ratio < 4.5)
    expect(dim).toEqual([])
  })

  test('the tokens a reader actually sees are all styled', () => {
    const classes = classesFor(
      [
        '// a note',
        'const total: number = 41 + 1',
        "export function name(): string { return 'hi' }",
      ].join('\n'),
    )
    for (const token of ['// a note', 'const', 'number', '41', "'hi'", 'name']) {
      expect(classes.get(token)).toBeString()
    }
  })

  /**
   * The complaint that produced this theme: a mono-accent palette can clear AA everywhere and
   * still read as flat, because what makes code scannable is one role differing from the next.
   *
   * A type name is deliberately not in this list. One Dark gives type names and number
   * literals the same `chalky`, which is the theme's own choice and not something to guard
   * against — so this asserts the separations it does make, rather than one it never claimed.
   */
  test('the roles a reader scans for are each a different colour', () => {
    const classes = classesFor(
      ['// a note', 'const total = 41 + 1', "function greet(): string { return 'hi' }"].join('\n'),
    )
    const roles = ['// a note', 'const', '41', "'hi'", 'greet'].map((token) => classes.get(token))
    expect(new Set(roles).size).toBe(roles.length)
  })
})
