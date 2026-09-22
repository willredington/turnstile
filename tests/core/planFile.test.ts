import { describe, expect, test } from 'bun:test'
import { planFileName } from '../../src/core/planFile.ts'

/**
 * Where a plan file is allowed to land.
 *
 * The tool exists so the agent has a sanctioned way to write the one file the harness keeps
 * for itself, instead of reaching for a shell redirect. Its safety is that the destination is
 * built rather than accepted, so these are the tests for "nothing but a filename survives".
 */
describe('naming a plan file', () => {
  test('an ordinary plan filename is kept', () => {
    expect(planFileName('add-a-license-file-dazzling-acorn.md')).toBe(
      'add-a-license-file-dazzling-acorn.md',
    )
  })

  test('a full path reduces to its basename, which cannot climb anywhere', () => {
    expect(planFileName('/Users/x/.claude/plans/my-plan.md')).toBe('my-plan.md')
  })

  test('traversal has nothing left to traverse with', () => {
    expect(planFileName('../../../etc/passwd')).toBeNull()
    expect(planFileName('../../.ssh/authorized_keys')).toBeNull()
    expect(planFileName('..')).toBeNull()
    expect(planFileName('../plan.md')).toBe('plan.md')
  })

  test('a backslash is a separator too, so a Windows-shaped path cannot smuggle one through', () => {
    expect(planFileName('..\\..\\plan.md')).toBe('plan.md')
  })

  test('only markdown', () => {
    expect(planFileName('plan.sh')).toBeNull()
    expect(planFileName('plan')).toBeNull()
    expect(planFileName('.md')).toBeNull()
  })

  test('nothing exotic in the name', () => {
    expect(planFileName('plan;rm -rf.md')).toBeNull()
    expect(planFileName('plan$(whoami).md')).toBeNull()
    expect(planFileName('.hidden.md')).toBeNull()
    expect(planFileName('')).toBeNull()
  })
})
