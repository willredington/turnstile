import { describe, expect, test } from 'bun:test'
import { REVIEW_SYSTEM_PROMPT } from '../../src/adapters/agent-sdk/reviewer.ts'
import { riskLabel } from '../../src/core/risk.ts'

/**
 * The prompts are the product. These assert the constraints that keep the tool from
 * degrading into the thing it exists to prevent — they are the closest thing to a unit
 * test a prompt can have.
 */
describe('prompt constraints', () => {
  test('the review prompt holds the change to the repository’s own conventions', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('its CLAUDE.md, its skills')
  })

  test('the review prompt judges the change, not what the code already did', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('Report problems the CHANGE introduces')
    expect(REVIEW_SYSTEM_PROMPT).toContain('Never report\nwhat the code already did')
  })

  /** A live test caught a broken test call 1 run in 3 without this; 8 in 8 with it. */
  test('the review prompt sends the reviewer after callers and other files', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('grep for every use of it, tests included')
    expect(REVIEW_SYSTEM_PROMPT).toContain('read it rather than assuming')
  })

  test('the review prompt makes an empty list the expected answer', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('MOST CHANGES ARE FINE')
  })

  test('the review prompt defines every severity and how to finish', () => {
    for (const level of ['low', 'medium', 'high']) expect(REVIEW_SYSTEM_PROMPT).toContain(level)
    expect(REVIEW_SYSTEM_PROMPT).toContain('submit_findings')
    expect(REVIEW_SYSTEM_PROMPT).toContain('fix exactly that and call it again')
  })
})

describe('riskLabel', () => {
  /** `none` is a verdict, not an absence — it must not read as a missing value. */
  test('renders none as an explicit verdict', () => {
    expect(riskLabel('none')).toBe('no findings')
  })

  test('renders risk levels', () => {
    expect(riskLabel('high')).toBe('high')
    expect(riskLabel('medium')).toBe('medium')
    expect(riskLabel('low')).toBe('low')
  })
})
