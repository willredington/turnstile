import { describe, expect, test } from 'bun:test'
import { describeReviewCall } from '../../src/core/reviewProgress.ts'

describe('describeReviewCall', () => {
  test('names what each tool acts on, relative to the root', () => {
    expect(describeReviewCall('/repo', 'Read', { file_path: '/repo/src/a.ts' })).toBe(
      'reading src/a.ts',
    )
    expect(describeReviewCall('/repo', 'Grep', { pattern: 'foo\\(' })).toBe('searching for foo\\(')
    expect(describeReviewCall('/repo', 'Glob', { pattern: '**/*.ts' })).toBe('listing **/*.ts')
    expect(describeReviewCall('/repo', 'Skill', { skill: 'tdd' })).toBe('using the tdd skill')
  })

  test('a command is named by its description when it has one, else its first line', () => {
    expect(
      describeReviewCall('/repo', 'Bash', { command: 'git log', description: 'Recent history' }),
    ).toBe('running Recent history')
    expect(describeReviewCall('/repo', 'Bash', { command: 'git log\n--stat' })).toBe(
      'running git log',
    )
  })

  test('long text is cut short, and missing input still reads as something', () => {
    const said = describeReviewCall('/repo', 'Bash', { command: 'x'.repeat(200) })
    expect(said.length).toBeLessThanOrEqual('running '.length + 80)
    expect(said.endsWith('…')).toBe(true)
    expect(describeReviewCall('/repo', 'Read', undefined)).toBe('reading')
    expect(describeReviewCall('/repo', 'mcp__mem0__search', {})).toBe('using search')
  })
})
