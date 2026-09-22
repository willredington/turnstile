import { describe, expect, test } from 'bun:test'
import { numbered } from '../../src/core/numbering.ts'

/**
 * Line numbering, shared by the reviewer and the asker. What matters is that it clamps rather
 * than running off either end of the file, since both callers compute ranges from line numbers
 * that may be stale.
 */

describe('numbered', () => {
  test('numbers a range of lines, clamped to the file', () => {
    expect(numbered('a\nb\nc', 2, 10)).toBe('2\tb\n3\tc')
  })

  test('numbers the whole file by default', () => {
    expect(numbered('a\nb')).toBe('1\ta\n2\tb')
  })

  test('a range starting before the file starts at line 1', () => {
    expect(numbered('a\nb', -5, 1)).toBe('1\ta')
  })

  test('a range entirely past the end is empty', () => {
    expect(numbered('a\nb', 9, 12)).toBe('')
  })
})
