/**
 * A plan, split into the blocks a reader argues with.
 *
 * The plan is markdown, and it is read as markdown — headings, lists and prose, not source. So
 * there are no lines on screen to drag over, and the unit a note attaches to is a block: a
 * heading, a paragraph, a list, a fenced example.
 *
 * Every block still carries the source lines it came from, because that is what the agent is
 * handed back. It wrote the plan as text and is about to revise it as text; "lines 11-15" is
 * something it can locate, and "the third block" is not.
 *
 * Deliberately not a markdown parser. It needs to know where blocks begin and end, not what
 * they mean — `marked` does the meaning, later, when each block is rendered. A parser here
 * would be a second opinion about the same document, and the two would disagree eventually.
 */

/** One block of a plan, and the lines of the plan it was written from. */
export type PlanBlock = {
  /** Stable across re-renders of the same plan: its first line, which cannot repeat. */
  key: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** The block's markdown, verbatim — what gets rendered, and what gets quoted. */
  text: string
}

const FENCE = /^\s*(```|~~~)/

/**
 * Split `plan` into blocks.
 *
 * Blank lines separate, except inside a fence, where they are part of the example. A run of
 * blank lines is spacing and becomes no block of its own: there is nothing there to disagree
 * with, and a handle beside it would be a target that means nothing.
 *
 * An unclosed fence runs to the end of the document rather than being abandoned — a plan is
 * often read while the agent is still writing it, and half a code block is still a block.
 */
export function planBlocks(plan: string): PlanBlock[] {
  const lines = plan.split('\n')
  const blocks: PlanBlock[] = []

  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    if (line.trim() === '') {
      at += 1
      continue
    }

    const start = at
    const fence = line.match(FENCE)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      at += 1
      while (at < lines.length && !(lines[at] ?? '').trimStart().startsWith(marker)) at += 1
      // The closing fence belongs to the block; past the end it simply was not there.
      if (at < lines.length) at += 1
    } else {
      while (at < lines.length) {
        const next = lines[at] ?? ''
        if (next.trim() === '' || FENCE.test(next)) break
        at += 1
      }
    }

    blocks.push({
      key: `b${start + 1}`,
      startLine: start + 1,
      endLine: at,
      text: lines.slice(start, at).join('\n'),
    })
  }

  return blocks
}

/** The blocks a note covers, by the source lines it names. */
export function blocksUnder(
  blocks: readonly PlanBlock[],
  startLine: number,
  endLine: number,
): PlanBlock[] {
  return blocks.filter((block) => block.startLine <= endLine && block.endLine >= startLine)
}

/**
 * Strip the markdown that renders away, so rendered text can be matched against its source.
 *
 * A reader highlights what they see — `chunking.ts` without its backticks, **must** without its
 * asterisks — and the source still has them. Whitespace collapses for the same reason: a list
 * item wrapped across two source lines is one run of words on screen.
 */
function flatten(text: string): string {
  return text
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Which of `block`'s source lines a highlighted passage came from.
 *
 * The rendered markdown carries no source positions, so the block is flattened line by line —
 * keeping a note of which line every character came from — and the flattened quote is looked up
 * in it. That is an exact match on the words, not a guess: the only fuzziness is in what
 * `flatten` removes, and it removes the same things from both sides.
 *
 * Falls back to the whole block when the quote cannot be placed — a selection spanning a
 * rendered artifact with no source of its own, say, like a table border or a list marker. The
 * note is still true, just less specific, which is the right way to be wrong here.
 */
export function quotedLines(
  block: PlanBlock,
  quote: string,
): { startLine: number; endLine: number } {
  const whole = { startLine: block.startLine, endLine: block.endLine }
  const needle = flatten(quote)
  if (needle === '') return whole

  const lines = block.text.split('\n')
  /** The source line each character of `hay` came from. */
  const from: number[] = []
  let hay = ''
  for (const [index, line] of lines.entries()) {
    const flat = flatten(line)
    if (flat === '') continue
    if (hay !== '') {
      hay += ' '
      from.push(block.startLine + index)
    }
    hay += flat
    for (let n = 0; n < flat.length; n += 1) from.push(block.startLine + index)
  }

  const at = hay.indexOf(needle)
  if (at === -1) return whole

  const startLine = from[at] ?? block.startLine
  const endLine = from[Math.min(at + needle.length - 1, from.length - 1)] ?? block.endLine
  return { startLine, endLine }
}
