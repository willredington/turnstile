import type { RiskLevel } from './types.ts'

/** A reviewed change's level rendered for a reader: `none` is a verdict, not an absence. */
export function riskLabel(level: RiskLevel): string {
  return level === 'none' ? 'no findings' : level
}
