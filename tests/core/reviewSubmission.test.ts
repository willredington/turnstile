import { describe, expect, test } from 'bun:test'
import { groupFindings, type SubmittedFinding } from '../../src/core/reviewSubmission.ts'

const submitted = (overrides: Partial<SubmittedFinding> = {}): SubmittedFinding => ({
  path: 'src/a.ts',
  startLine: 3,
  endLine: 4,
  severity: 'medium',
  title: 'Dropped promise',
  message: 'Its rejection is never handled.',
  ...overrides,
})

const { cause: _, ...asFinding } = submitted()

describe('groupFindings', () => {
  test('every reviewed file has an entry, empty when nothing was found', () => {
    const result = groupFindings(['src/a.ts', 'src/b.ts'], [])
    expect(result).toEqual({
      byFile: new Map([
        ['src/a.ts', []],
        ['src/b.ts', []],
      ]),
    })
  })

  test('a finding in a reviewed file belongs to that file', () => {
    const result = groupFindings(['src/a.ts', 'src/b.ts'], [submitted()])
    expect('byFile' in result && result.byFile.get('src/a.ts')).toEqual([asFinding])
  })

  test('a finding elsewhere belongs to the file it names as its cause', () => {
    const caller = submitted({ path: 'src/caller.ts', cause: 'src/b.ts' })
    const result = groupFindings(['src/a.ts', 'src/b.ts'], [caller])
    expect('byFile' in result && result.byFile.get('src/b.ts')).toEqual([
      { ...asFinding, path: 'src/caller.ts' },
    ])
  })

  test('a finding elsewhere with no cause is refused, and says what to do', () => {
    const result = groupFindings(['src/a.ts'], [submitted({ path: 'src/caller.ts' })])
    expect('error' in result && result.error).toContain('name the file under review')
  })

  test('a cause that is not under review is refused', () => {
    const result = groupFindings(
      ['src/a.ts'],
      [submitted({ path: 'src/caller.ts', cause: 'src/other.ts' })],
    )
    expect('error' in result && result.error).toContain('cause src/other.ts')
  })

  test('every problem is reported at once', () => {
    const result = groupFindings(
      ['src/a.ts'],
      [
        submitted({ path: '/abs/a.ts' }),
        submitted({ startLine: 9, endLine: 2 }),
        submitted({ title: ' ' }),
      ],
    )
    const error = 'error' in result ? result.error : ''
    expect(error).toContain('relative to the repository root')
    expect(error).toContain('startLine <= endLine')
    expect(error).toContain('a title and a message')
  })
})
