import { describe, expect, test } from 'bun:test'
import { BINARY_SNIFF_BYTES, looksBinary } from '../../src/core/binary.ts'

/**
 * Whether a file's bytes are binary — the guard that keeps a PDF (or a PNG, or a compiled
 * object file) from ever reaching a line-rendering surface. See `src/core/binary.ts` for why
 * a NUL byte is the signal.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('looksBinary', () => {
  test('plain ASCII text is not binary', () => {
    expect(looksBinary(utf8('export const a = 1\n'))).toBe(false)
  })

  test('empty content is not binary', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })

  test('a NUL byte marks content as binary', () => {
    expect(looksBinary(bytes(0x25, 0x50, 0x44, 0x46, 0x00, 0x0a))).toBe(true)
  })

  test('multi-byte UTF-8 is not binary', () => {
    // High bytes are ordinary in UTF-8 text, so they must never be the signal on their own —
    // otherwise every file with an accent or an emoji in it would refuse to open.
    expect(looksBinary(utf8('const greeting = "héllo — 🌍"\n'))).toBe(false)
  })

  test('tabs, newlines and carriage returns are not binary', () => {
    expect(looksBinary(utf8('a\tb\r\nc\n'))).toBe(false)
  })

  test('a NUL past the sniffed window does not count', () => {
    // A bounded scan, like git's: the cost of this check has to stay flat no matter how big
    // the file is, since it runs on every file the browser opens.
    const content = new Uint8Array(BINARY_SNIFF_BYTES + 10)
    content.fill(0x61)
    content[BINARY_SNIFF_BYTES + 5] = 0x00
    expect(looksBinary(content)).toBe(false)
  })

  test('a NUL at the last sniffed byte still counts', () => {
    const content = new Uint8Array(BINARY_SNIFF_BYTES + 10)
    content.fill(0x61)
    content[BINARY_SNIFF_BYTES - 1] = 0x00
    expect(looksBinary(content)).toBe(true)
  })
})
