import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

/**
 * How code is coloured: One Dark's palette, on Terminal's own ground.
 *
 * The CodeMirror migration left `defaultHighlightStyle` in place — CodeMirror's *light* theme,
 * picked for black-on-white, rendered on a dark background. This replaces it.
 *
 * The first attempt at a replacement mapped syntax onto the app's own tokens, which are a
 * deliberate mono-accent scheme: purple and grey and nothing else. Every colour in it cleared
 * AA against the background and it still read as flat, because contrast against the *ground*
 * is not the thing that makes code scannable — contrast between one role and the next is, and
 * a single hue cannot supply it. One Dark is nine hues that a lot of people already read
 * fluently, which is worth more here than matching the chrome.
 *
 * **Only the highlight style is taken, never `oneDarkTheme`.** The editor's chrome — the
 * transparent background, the caret and selection, the gutter — stays the app's, in
 * `styles.css`. That is not just for looks: One Dark is designed for its own `#282c34`, and
 * Turnstile's ground is darker, so every one of these colours measures *better* here than in
 * the theme it comes from. On Terminal's `#05080a` the lowest is `stone` (comments) at 5.54:1
 * and `coral` (keywords) at 6.28:1, against 3.86 and 4.38 on stock One Dark — it gained again
 * when the ground went from Nocturne's `#161826` to near-black. `editorHighlight.test.ts`
 * reads `--color-bg` straight out of the stylesheet, so it holds that line across a retheme
 * rather than against one hardcoded ground.
 *
 * **The Terminal retheme kept this rather than going green, deliberately.** That design hand-
 * colours its sample code in the interface's own phosphor — keywords green, strings amber,
 * everything else grey-green — and all six of those clear AA here. It was still declined, for
 * the reason in the paragraph above: contrast against the *ground* is not what makes code
 * scannable, contrast between one role and the next is, and collapsing nine hues onto two is
 * the same move that failed the first time. The chrome is green; the code is not.
 *
 * One consequence worth knowing, and it got sharper under Terminal: One Dark colours strings
 * green and keywords red-ish, and Turnstile's diff tints — `.ts-add`, `.ts-removed` — are now
 * a *phosphor* green and red wash behind this text. They still read as separate things (a wash
 * is a background, a token is a glyph, which is how every editor layers the two), and the add
 * wash is only 10% alpha, but this is the collision to look at first if the diff ever stops
 * reading. It was accepted deliberately rather than overlooked.
 */
export const codeHighlight = oneDarkHighlightStyle
