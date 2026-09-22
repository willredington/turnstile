import { describe, expect, test } from 'bun:test'
import { proposedContent, resolveEdit } from '../../src/app/editResolution.ts'

describe('resolveEdit', () => {
  test('oldText null (whole-file write) is always ok, even against a nonexistent file', () => {
    expect(resolveEdit('src/x.ts', null, null)).toEqual({ ok: true })
    expect(resolveEdit('src/x.ts', 'anything', null)).toEqual({ ok: true })
  })

  test('oldText given but the file does not exist yet is rejected', () => {
    const result = resolveEdit('src/x.ts', null, 'old')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('does not exist')
  })

  test('oldText given but not found in the current content is rejected', () => {
    const result = resolveEdit('src/x.ts', 'current content', 'not present')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('not found')
  })

  test('oldText given and found in the current content is ok', () => {
    expect(resolveEdit('src/x.ts', 'current content', 'current')).toEqual({ ok: true })
  })
})

describe('proposedContent', () => {
  test('Write-style: oldText is null, newText is the whole proposed file', () => {
    expect(proposedContent('anything, or null', null, 'brand new content\n')).toBe(
      'brand new content\n',
    )
    expect(proposedContent(null, null, 'brand new content\n')).toBe('brand new content\n')
  })

  test('Edit-style: substitutes the matched snippet into the current content', () => {
    const current = 'line one\nline two\nline three\n'
    const result = proposedContent(current, 'line two', 'line TWO')
    expect(result).toBe('line one\nline TWO\nline three\n')
  })

  test('Edit-style on a file that does not exist: falls back to newText alone', () => {
    expect(proposedContent(null, 'old', 'new')).toBe('new')
  })

  /**
   * `$&`, `` $` ``, `$'`, `$$` and `$1` are substitution patterns to `String.replace` when the
   * replacement is a plain string. Shell quoting idioms and regex snippets are full of them,
   * and pattern-interpreting one means the human reviews content the write will not produce —
   * under a chunk key the real post-write chunk will never match.
   */
  test('Edit-style: $-sequences in the replacement are inserted literally, not interpreted', () => {
    const current = 'before\nMARKER\nafter\n'

    expect(proposedContent(current, 'MARKER', 'echo "$&"')).toBe('before\necho "$&"\nafter\n')
    expect(proposedContent(current, 'MARKER', "sed 's/x/$1/'")).toBe(
      "before\nsed 's/x/$1/'\nafter\n",
    )
    expect(proposedContent(current, 'MARKER', 'PID=$$')).toBe('before\nPID=$$\nafter\n')
    expect(proposedContent(current, 'MARKER', "prefix$`suffix$'")).toBe(
      "before\nprefix$`suffix$'\nafter\n",
    )
  })
})
