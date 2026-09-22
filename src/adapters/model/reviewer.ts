import { generateText, isStepCount, type LanguageModel, tool } from 'ai'
import type { ReviewConfig } from '../../core/config.ts'
import { numbered } from '../../core/numbering.ts'
import type { FileReviewInput, Reviewer } from '../../core/ports.ts'
import type { Rule } from '../../core/rules.ts'
import type { Chunk, Finding } from '../../core/types.ts'
import { findingsFromVerdicts, verdictSchema } from '../../core/verdicts.ts'
import { runTelemetry } from './client.ts'
import { REVIEW_SYSTEM_PROMPT } from './prompts.ts'
import { readOnlyTools } from './tools.ts'

/**
 * One review per changed file: a small tool-using agent that sees the file, its diff, the rules
 * that govern it, and can read and search the rest of the repository — because whether a change
 * keeps a rule often turns on something outside the changed lines.
 *
 * It answers with a typed verdict per rule (`core/verdicts.ts`) through `submit_verdicts`, rather
 * than a structured-output response format: asking for a JSON response format while tools are
 * also on offer is exactly the combination providers disagree about, and a tool call is the one
 * shape every tool-capable model already speaks. The tool checks the submission as it arrives
 * and hands back what is wrong with it, so an incomplete answer is corrected within the run
 * rather than costing a retry. The last step allows nothing else, so a run that has not
 * submitted by then is made to.
 */

/** Past this, the reviewed file is shown only around its changes. */
const MAX_FILE_LINES = 1500
/** Lines of surrounding file kept on either side of a change when the file is cut. */
const WINDOW = 60

const SUBMIT = 'submit_verdicts'

/** Render a chunk as the diff text a model should reason about. */
function renderChunk(chunk: Chunk): string {
  const body = chunk.hunks
    .map((hunk) => {
      const header = hunk.context === '' ? '' : `… ${hunk.context}\n`
      const lines = hunk.lines
        .map((line) => {
          const symbol = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
          return `${symbol}${line.text}`
        })
        .join('\n')
      return `${header}${lines}`
    })
    .join('\n\n')

  return [`lines ${chunk.startLine}-${chunk.endLine}:`, '```diff', body, '```'].join('\n')
}

/** The whole file with line numbers — or, for a very long one, just the regions around its changes. */
function renderFile(content: string, chunks: readonly Chunk[]): string {
  const total = content.split('\n').length
  if (total <= MAX_FILE_LINES) return numbered(content)

  const windows: [number, number][] = []
  for (const chunk of chunks) {
    const start = Math.max(1, chunk.startLine - WINDOW)
    const end = Math.min(total, chunk.endLine + WINDOW)
    const last = windows.at(-1)
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else windows.push([start, end])
  }
  return [
    `(${total} lines — showing the regions around the changes; read_file for the rest)`,
    ...windows.map(([start, end]) => numbered(content, start, end)),
  ].join('\n…\n')
}

function renderRule(rule: Rule): string {
  return [
    `### ${rule.name}`,
    `_${rule.description}_`,
    rule.rule,
    rule.violates === undefined ? '' : `Counts as a violation: ${rule.violates}`,
    rule.complies === undefined ? '' : `Does not count: ${rule.complies}`,
    rule.severity === undefined
      ? ''
      : `Severity is fixed at ${rule.severity}; give null for it in your verdict.`,
  ]
    .filter((part) => part !== '')
    .join('\n')
}

function renderPrompt(input: FileReviewInput): string {
  const heading =
    input.previousPath === undefined ? input.path : `${input.previousPath} → ${input.path}`
  const sections = [
    `## Rules governing ${input.path} — give a verdict on every one`,
    input.rules.map(renderRule).join('\n\n'),
  ]
  if (input.context.length > 0) {
    sections.push(
      '',
      '## Context docs (written for the coder — background, not rules)',
      ...input.context.map((doc) => `### ${doc.path}\n${doc.body.trim()}`),
    )
  }
  sections.push(
    '',
    `## The change: ${heading} (${input.kind})`,
    ...input.chunks.map(renderChunk),
    '',
    `## ${input.path} as it stands now`,
    input.content === null ? '(deleted)' : renderFile(input.content, input.chunks),
  )
  return sections.join('\n')
}

/**
 * The read tools, and the submit tool that checks each submission as it arrives. `accept` is
 * called once, with the findings of the first complete one.
 */
function toolsFor(input: FileReviewInput, accept: (findings: Finding[]) => void) {
  const [first, ...rest] = input.rules.map((rule) => rule.name)
  if (first === undefined) throw new Error('A review needs at least one rule.')
  return {
    ...readOnlyTools(input.reader, input.root),
    [SUBMIT]: tool({
      description:
        'Submit your verdict on every rule listed, exactly one each. Call once, last. If it is ' +
        'not accepted, the result says why: fix that and call it again.',
      inputSchema: verdictSchema([first, ...rest]),
      execute: async (verdicts) => {
        const result = findingsFromVerdicts(input.rules, verdicts)
        if ('error' in result) return result.error
        accept(result.findings)
        return 'Accepted.'
      },
    }),
  }
}

/** One retry, then give up. A slow review is bad; one that hangs on retries is worse. */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    return await operation()
  }
}

export function createModelReviewer(model: LanguageModel, config: ReviewConfig): Reviewer {
  return {
    reviewFile: (input) =>
      withRetry(async (): Promise<Finding[]> => {
        let accepted: Finding[] | null = null
        await generateText({
          model,
          system: REVIEW_SYSTEM_PROMPT,
          prompt: renderPrompt(input),
          tools: toolsFor(input, (findings) => {
            accepted ??= findings
          }),
          stopWhen: [isStepCount(config.maxSteps), () => accepted !== null],
          prepareStep: ({ stepNumber }) =>
            stepNumber >= config.maxSteps - 1
              ? { toolChoice: { type: 'tool', toolName: SUBMIT }, activeTools: [SUBMIT] }
              : {},
          abortSignal: AbortSignal.timeout(config.timeoutMs),
          telemetry: runTelemetry('turnstile.review'),
        })
        if (accepted === null) {
          throw new Error('The reviewer finished without an accepted verdict on every rule.')
        }
        return accepted
      }),
  }
}
