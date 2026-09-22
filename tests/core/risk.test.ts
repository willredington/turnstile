import { describe, expect, test } from 'bun:test'
import { REVIEW_SYSTEM_PROMPT } from '../../src/adapters/model/prompts.ts'
import { riskLabel } from '../../src/core/risk.ts'

/**
 * The prompts are the product. These assert the constraints that keep the tool from
 * degrading into the thing it exists to prevent — they are the closest thing to a unit
 * test a prompt can have.
 */
describe('prompt constraints', () => {
  test('the review prompt asks for a verdict on every rule, and nothing else', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('verdict on EVERY rule')
    expect(REVIEW_SYSTEM_PROMPT).toContain('exactly one verdict')
    expect(REVIEW_SYSTEM_PROMPT).toContain('a problem no rule describes is not yours to raise')
  })

  test('the review prompt judges the change, not what the file already did', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('what the CHANGE introduces or breaks')
  })

  /** A live test caught a broken test call 1 run in 3 without this; 8 in 8 with it. */
  test('the review prompt sends the reviewer after callers and other files a rule needs', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('grep for every use of it, tests included')
    expect(REVIEW_SYSTEM_PROMPT).toContain('go and read it rather than assuming')
  })

  test('the review prompt makes a kept rule the expected answer', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('MOST RULES ARE KEPT BY MOST CHANGES')
  })

  test('the review prompt defines every severity and how to finish', () => {
    for (const level of ['low', 'medium', 'high']) expect(REVIEW_SYSTEM_PROMPT).toContain(level)
    expect(REVIEW_SYSTEM_PROMPT).toContain('submit_verdicts')
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
