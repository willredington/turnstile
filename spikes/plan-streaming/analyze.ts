/**
 * Summarises the probe logs: how finely plan text streams, and how much of the plan outside
 * the section the note was about changed between rounds.
 *
 *   bun spikes/plan-streaming/analyze.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TARGET = 'Testing'
const logsDir = join(import.meta.dir, 'logs')

type Log = {
  mode: string
  label: string
  model: string
  deltas: { t: number; tool: string; bytes: number }[]
  toolCalls: { t: number; name: string; bytes: number }[]
  rounds: { inputPlan: string; planFile: string | null; matchesFile: boolean | null }[]
  error: string | null
}

/** `## Heading` → body, in order. Text before the first heading is keyed ''. */
function sections(plan: string): Map<string, string> {
  const out = new Map<string, string>()
  let key = ''
  let body: string[] = []
  for (const line of plan.split('\n')) {
    const m = line.match(/^##\s+(.*)$/)
    if (m) {
      out.set(key, body.join('\n'))
      key = (m[1] ?? '').trim()
      body = []
    } else body.push(line)
  }
  out.set(key, body.join('\n'))
  return out
}

/** Lines of `a` not present, in order, in `b` — a cheap LCS-free drift measure. */
function changedLines(a: string, b: string): number {
  const bs = new Set(b.split('\n'))
  return a.split('\n').filter((l) => l.trim() !== '' && !bs.has(l)).length
}

const rows: string[] = []
for (const file of readdirSync(logsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const log = JSON.parse(readFileSync(join(logsDir, file), 'utf8')) as Log
  const planDeltas = log.deltas.filter((d) => /write_plan|edit_plan/.test(d.tool))
  const maxDelta = Math.max(0, ...planDeltas.map((d) => d.bytes))
  const planCalls = log.toolCalls.filter((c) => /write_plan|edit_plan/.test(c.name))
  const r2Calls = planCalls.filter(
    (c) => c.t > (log.toolCalls.find((x) => x.name === 'ExitPlanMode')?.t ?? Infinity),
  )

  let drift = 'n/a'
  if (log.rounds.length >= 2) {
    const a = sections(log.rounds[0]?.inputPlan ?? '')
    const b = sections(log.rounds[1]?.inputPlan ?? '')
    const changed: string[] = []
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (key.includes(TARGET)) continue
      const before = a.get(key)
      const after = b.get(key)
      if (before === after) continue
      const n =
        before === undefined || after === undefined
          ? 'added/removed'
          : `${changedLines(before, after)}+${changedLines(after, before)} lines`
      changed.push(`${key || '(preamble)'}: ${n}`)
    }
    drift = changed.length === 0 ? 'none — only the noted section changed' : changed.join('; ')
  }

  rows.push(
    [
      `${log.mode}-${log.label}`,
      `rounds=${log.rounds.length}`,
      `planDeltas=${planDeltas.length} max=${maxDelta}B`,
      `round2 calls=[${r2Calls.map((c) => `${c.name.replace('mcp__probe__', '')}:${c.bytes}B`).join(', ')}]`,
      `inputPlan==file: ${log.rounds.map((r) => r.matchesFile).join('/')}`,
      `drift outside "${TARGET}": ${drift}`,
      log.error ? `error=${log.error}` : '',
    ]
      .filter(Boolean)
      .join('\n  '),
  )
}
console.log(rows.join('\n\n'))
