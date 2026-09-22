import { describe, expect, test } from 'bun:test'
import { blocksUnder, planBlocks, quotedLines } from '../../src/core/planBlocks.ts'

/**
 * A plan, split into the blocks a reader argues with.
 *
 * The rules here are all about what a note can be attached to: something that is actually on
 * screen, and something the agent can find again in its own text.
 */

describe('splitting a plan into blocks', () => {
  test('a blank line separates', () => {
    expect(planBlocks('one\n\ntwo').map((b) => b.text)).toEqual(['one', 'two'])
  })

  test('contiguous lines stay together, so a list is one block', () => {
    const blocks = planBlocks('## Steps\n1. first\n2. second\n\nafter')
    expect(blocks.map((b) => b.text)).toEqual(['## Steps\n1. first\n2. second', 'after'])
  })

  test('every block knows the lines it came from', () => {
    const blocks = planBlocks('one\n\n\nfour\nfive')
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([
      [1, 1],
      [4, 5],
    ])
  })

  test('a run of blank lines is spacing, not a block', () => {
    // A handle beside nothing is a target that means nothing.
    expect(planBlocks('\n\n\nonly\n\n\n')).toHaveLength(1)
  })

  test('blank lines inside a fence are part of the example', () => {
    const blocks = planBlocks('```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toBe('```ts\nconst a = 1\n\nconst b = 2\n```')
  })

  test('a fence begins a block even with no blank line before it', () => {
    const blocks = planBlocks('prose\n```\ncode\n```')
    expect(blocks.map((b) => b.text)).toEqual(['prose', '```\ncode\n```'])
  })

  test('an unclosed fence runs to the end rather than being abandoned', () => {
    // A plan can be read while the agent is still writing it.
    const blocks = planBlocks('```ts\nhalf a block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.endLine).toBe(2)
  })

  test('a tilde fence closes on a tilde, not a backtick', () => {
    const blocks = planBlocks('~~~\n```\nstill inside\n~~~\n\nafter')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toContain('still inside')
  })

  test('keys are stable and distinct', () => {
    const keys = planBlocks('one\n\ntwo\n\nthree').map((b) => b.key)
    expect(new Set(keys).size).toBe(3)
    expect(planBlocks('one\n\ntwo\n\nthree').map((b) => b.key)).toEqual(keys)
  })

  test('an empty plan has no blocks', () => {
    expect(planBlocks('')).toEqual([])
  })
})

describe('which blocks a note covers', () => {
  const blocks = planBlocks('one\n\ntwo\nthree\n\nfour')

  test('a note inside one block covers only it', () => {
    expect(blocksUnder(blocks, 3, 3).map((b) => b.text)).toEqual(['two\nthree'])
  })

  test('a note spanning blocks covers each of them', () => {
    expect(blocksUnder(blocks, 1, 4).map((b) => b.key)).toEqual(['b1', 'b3'])
  })

  test('a note over the blank line between two blocks touches neither', () => {
    expect(blocksUnder(blocks, 2, 2)).toEqual([])
  })
})

/**
 * Where a highlighted passage came from.
 *
 * The point of the whole surface is that a note lands on the part of the plan it is about, so
 * "somewhere in this block" is not good enough when the block is a six-step list.
 */
describe('placing a highlight back in the source', () => {
  const list = planBlocks(
    '## Steps\n1. Add yaml beside yml.\n2. Extend skipReasons.\n3. Rewrite it.',
  )[0]

  test('one line of a list narrows to that line', () => {
    expect(list && quotedLines(list, 'Extend skipReasons.')).toEqual({ startLine: 3, endLine: 3 })
  })

  test('a passage across two lines covers both', () => {
    expect(list && quotedLines(list, 'yml. 2. Extend')).toEqual({ startLine: 2, endLine: 3 })
  })

  test('the markdown that renders away does not have to be selected', () => {
    // The reader highlights `chunking.ts` without its backticks, because that is what is on
    // screen; the source still has them.
    const block = planBlocks('Rewrite `chunking.ts` now.')[0]
    expect(block && quotedLines(block, 'chunking.ts')).toEqual({ startLine: 1, endLine: 1 })
  })

  test('a heading and its list are told apart', () => {
    expect(list && quotedLines(list, 'Steps')).toEqual({ startLine: 1, endLine: 1 })
  })

  test('a passage that cannot be placed falls back to the whole block', () => {
    expect(list && quotedLines(list, 'nothing like this text')).toEqual({
      startLine: 1,
      endLine: 4,
    })
  })

  test('an empty quote falls back rather than matching everything', () => {
    expect(list && quotedLines(list, '   ')).toEqual({ startLine: 1, endLine: 4 })
  })

  test('a block that does not start at line 1 reports real line numbers', () => {
    const later = planBlocks('intro\n\n1. first\n2. second')[1]
    expect(later && quotedLines(later, 'second')).toEqual({ startLine: 4, endLine: 4 })
  })
})
