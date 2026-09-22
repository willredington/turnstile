import { describe, expect, test } from 'bun:test'
import { neighbourOf, openFile, tabKey } from '../../src/core/tabs.ts'

/**
 * The tab strip's bookkeeping: which tab takes the screen when one goes away, what opening a
 * file does to the strip, and what counts as the same tab.
 */

describe('the neighbour a closing tab hands over to', () => {
  const tabs = ['a.ts', 'b.ts', 'c.ts']

  test('the one after it', () => {
    expect(neighbourOf(tabs, 1)).toBe('c.ts')
  })

  test('the first hands over rightwards, not to the row', () => {
    expect(neighbourOf(tabs, 0)).toBe('b.ts')
  })

  test('the last falls back to the one before it', () => {
    expect(neighbourOf(tabs, 2)).toBe('b.ts')
  })

  test('the only one leaves nothing', () => {
    expect(neighbourOf(['a.ts'], 0)).toBeNull()
  })

  test('an empty list leaves nothing', () => {
    expect(neighbourOf([], 0)).toBeNull()
  })

  test('a tab that was not in the list moves nothing', () => {
    expect(neighbourOf(tabs, -1)).toBeNull()
  })

  test('works on whatever the row is made of, not just paths', () => {
    expect(neighbourOf([{ path: 'a' }, { path: 'b' }], 0)).toEqual({ path: 'b' })
  })
})

describe('opening a file', () => {
  test('the first one starts the row', () => {
    expect(openFile([], 'src/a.ts')).toEqual(['src/a.ts'])
  })

  test('later ones go on the end, in the order they were opened', () => {
    expect(openFile(openFile(['src/a.ts'], 'src/b.ts'), 'src/c.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ])
  })

  test('opening one that is already a tab changes nothing', () => {
    expect(openFile(['src/a.ts', 'src/b.ts'], 'src/a.ts')).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('does not mutate the list it was given', () => {
    const open = ['src/a.ts']
    openFile(open, 'src/b.ts')
    expect(open).toEqual(['src/a.ts'])
  })
})

describe("one tab's identity", () => {
  test('a board tab is its root and its path together', () => {
    expect(tabKey('/repo', 'src/a.ts')).toBe('/repo\0src/a.ts')
  })

  test("a tab on the reader's own row is its path alone", () => {
    expect(tabKey(null, 'src/a.ts')).toBe('src/a.ts')
  })

  test('the same path under two roots is two tabs', () => {
    expect(tabKey('/one', 'a.ts')).not.toBe(tabKey('/two', 'a.ts'))
  })

  // The separator is what keeps the two shapes apart, and it only works because a path can
  // never contain a NUL — `safePath` rejects one outright.
  test('a rootless key is not the same as an empty root', () => {
    expect(tabKey(null, 'a')).not.toBe(tabKey('a', ''))
  })
})
