import type { RuleSource } from '../../src/core/ports.ts'
import { ruleFrom } from '../../src/core/rules.ts'

/**
 * One rule governing every file. A file no rule governs is never sent to the reviewer, so a fake
 * rule source with nothing in it would switch the review off in any test that relies on one.
 */
const result = ruleFrom('everywhere.yaml', { description: 'Keep it tidy', rule: 'Keep it tidy.' })
if ('error' in result) throw new Error(result.error)

export const EVERY_FILE: RuleSource = {
  load: async () => ({ rules: [result.rule], context: [], warnings: [] }),
}
