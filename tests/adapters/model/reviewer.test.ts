import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { createModelReviewer } from '../../../src/adapters/model/reviewer.ts'
import { DEFAULT_CONFIG } from '../../../src/core/config.ts'
import type { FileReviewInput, RepoReader } from '../../../src/core/ports.ts'
import { type Rule, ruleFrom } from '../../../src/core/rules.ts'
import type { Chunk, Finding } from '../../../src/core/types.ts'

/**
 * The reviewer agent, driven by a scripted model rather than a real one: each step's reply is
 * queued up front, and every call the model receives is recorded — so what the reviewer is
 * shown, which tools it is offered, and how it finishes can all be checked without a network.
 */

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>

function rule(name: string, data: Record<string, unknown>): Rule {
  const result = ruleFrom(`${name}.yaml`, data)
  if ('error' in result) throw new Error(result.error)
  return result.rule
}

const NO_DEFAULTS = rule('no-default-exports', {
  description: 'Named exports only',
  globs: 'src/**',
  rule: 'Use named exports.',
  violates: 'Any `export default`.',
  complies: 'Every export is named.',
})
const NO_CONSOLE = rule('no-console', {
  description: 'Log through the logger',
  severity: 'high',
  rule: 'Never call console.',
})

const BROKEN = {
  rule: 'no-default-exports',
  violated: true,
  severity: 'medium',
  locations: [{ path: 'src/a.ts', startLine: 2, endLine: 2 }],
}
const KEPT = { rule: 'no-console', violated: false, severity: null, locations: [] }

/** What `BROKEN` and `KEPT` add up to: the rule's own words, where the reviewer said. */
const FINDING: Finding = {
  path: 'src/a.ts',
  startLine: 2,
  endLine: 2,
  severity: 'medium',
  rule: 'no-default-exports',
  message: 'Named exports only',
}

const submit = (id: string, verdicts: unknown[]) => toolCall(id, 'submit_verdicts', { verdicts })

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function toolCall(id: string, toolName: string, input: unknown): GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: USAGE,
    warnings: [],
  } as GenerateResult
}

function text(reply: string): GenerateResult {
  return {
    content: [{ type: 'text', text: reply }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  } as GenerateResult
}

/** A model that replies with `steps`, in order, recording what it was asked each time. */
function scripted(steps: GenerateResult[]) {
  const calls: CallOptions[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      const step = steps[calls.length - 1]
      if (step === undefined) throw new Error('the script ran out')
      return step
    },
  })
  return { model, calls }
}

const reads: string[] = []
const reader: RepoReader = {
  read: async (_root, path) => {
    reads.push(path)
    return path === 'src/b.ts' ? 'import a from "./a"\nexport const b = a\n' : null
  },
  glob: async () => ({ paths: ['src/a.ts', 'src/b.ts'], truncated: false }),
  grep: async () => ({
    matches: [{ path: 'src/b.ts', line: 1, text: 'import a' }],
    truncated: false,
  }),
}

const CHUNK: Chunk = {
  key: 'k1',
  root: '/repo',
  path: 'src/a.ts',
  kind: 'modified',
  startLine: 2,
  endLine: 2,
  addedCount: 1,
  removedCount: 0,
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      context: '',
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'const a = 1' },
        { kind: 'add', oldLine: null, newLine: 2, text: 'export default a' },
      ],
    },
  ],
  analyzable: true,
  wholeFile: false,
}

function input(overrides: Partial<FileReviewInput> = {}): FileReviewInput {
  return {
    root: '/repo',
    path: 'src/a.ts',
    kind: 'modified',
    content: 'const a = 1\nexport default a\n',
    chunks: [CHUNK],
    rules: [NO_DEFAULTS, NO_CONSOLE],
    context: [{ path: 'CLAUDE.md', body: 'Ports and adapters.' }],
    reader,
    ...overrides,
  }
}

const CONFIG = DEFAULT_CONFIG.review

/** Every prompt message's text, flattened, for asserting on what the model was shown. */
function shown(call: CallOptions | undefined): string {
  return JSON.stringify(call?.prompt ?? [])
}

describe('createModelReviewer', () => {
  test('shows the model every rule with all its fields, the context docs, the diff and the numbered file', async () => {
    const { model, calls } = scripted([submit('1', [KEPT, { ...BROKEN, violated: false }])])
    await createModelReviewer(model, CONFIG).reviewFile(input())

    const prompt = shown(calls[0])
    for (const part of [
      'no-default-exports',
      'Named exports only',
      'Use named exports.',
      'Counts as a violation: Any `export default`.',
      'Does not count: Every export is named.',
      'no-console',
      'Severity is fixed at high',
      'CLAUDE.md',
      'Ports and adapters.',
      '+export default a',
      '2\\texport default a',
    ]) {
      expect(prompt).toContain(part)
    }
  })

  test('offers read, glob, grep and submit tools', async () => {
    const { model, calls } = scripted([submit('1', [KEPT, { ...BROKEN, violated: false }])])
    await createModelReviewer(model, CONFIG).reviewFile(input())
    const names = (calls[0]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : ''))
    expect(names.sort()).toEqual(['glob', 'grep', 'read_file', 'submit_verdicts'])
  })

  /** The rule names are an enum in the tool's own schema, so a provider can hold the model to them. */
  test("the submit tool's schema names exactly the governing rules", async () => {
    const { model, calls } = scripted([submit('1', [KEPT, { ...BROKEN, violated: false }])])
    await createModelReviewer(model, CONFIG).reviewFile(input())
    const submitTool = (calls[0]?.tools ?? []).find(
      (tool) => 'name' in tool && tool.name === 'submit_verdicts',
    )
    const schema = JSON.stringify(
      submitTool && 'inputSchema' in submitTool ? submitTool.inputSchema : {},
    )
    expect(schema).toContain('"enum":["no-default-exports","no-console"]')
  })

  test('turns its verdicts into findings that carry the rule, not the model, as the message', async () => {
    const { model } = scripted([submit('1', [BROKEN, KEPT])])
    expect(await createModelReviewer(model, CONFIG).reviewFile(input())).toEqual([FINDING])
  })

  /** The point of giving it tools: look at a caller, then answer — here, the caller is the finding. */
  test('runs its tools against the repository, and can place a violation in another file', async () => {
    reads.length = 0
    const { model, calls } = scripted([
      toolCall('1', 'grep', { pattern: 'from "./a"' }),
      toolCall('2', 'read_file', { path: 'src/b.ts' }),
      submit('3', [
        {
          ...BROKEN,
          locations: [...BROKEN.locations, { path: 'src/b.ts', startLine: 1, endLine: 1 }],
        },
        KEPT,
      ]),
    ])
    const findings = await createModelReviewer(model, CONFIG).reviewFile(input())

    expect(findings).toEqual([FINDING, { ...FINDING, path: 'src/b.ts', startLine: 1, endLine: 1 }])
    expect(calls).toHaveLength(3)
    expect(reads).toEqual(['src/b.ts'])
    // The read's result reached the model, numbered.
    expect(shown(calls[2])).toContain('2\\texport const b = a')
  })

  /** Refused with the reason, and fixed within the same run — not a retry of the whole review. */
  test('an incomplete submission is handed back, and the corrected one is accepted', async () => {
    const { model, calls } = scripted([submit('1', [BROKEN]), submit('2', [BROKEN, KEPT])])
    const findings = await createModelReviewer(model, CONFIG).reviewFile(input())

    expect(findings).toEqual([FINDING])
    expect(calls).toHaveLength(2)
    expect(shown(calls[1])).toContain('missing a verdict for: no-console')
  })

  /** A run that has not submitted by its last step is made to, with nothing else on offer. */
  test('forces a submit on the last step', async () => {
    const { model, calls } = scripted([
      toolCall('1', 'glob', { pattern: '**/*' }),
      toolCall('2', 'glob', { pattern: '**/*' }),
      submit('3', [BROKEN, KEPT]),
    ])
    await createModelReviewer(model, { ...CONFIG, maxSteps: 3 }).reviewFile(input())

    expect(calls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(calls[2]?.toolChoice).toEqual({ type: 'tool', toolName: 'submit_verdicts' })
    expect((calls[2]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : ''))).toEqual([
      'submit_verdicts',
    ])
  })

  test('a run that never submits is a failure, not an empty review', async () => {
    const { model } = scripted([text('Looks fine to me.'), text('Looks fine to me.')])
    await expect(createModelReviewer(model, CONFIG).reviewFile(input())).rejects.toThrow(
      'without an accepted verdict',
    )
  })

  /** Out of steps with every submission refused: failed, and retried once like any failure. */
  test('a run whose submissions are all refused fails, after one retry', async () => {
    const { model, calls } = scripted([
      submit('1', [BROKEN]),
      submit('2', [BROKEN]),
      submit('3', [BROKEN]),
      submit('4', [BROKEN]),
    ])
    await expect(
      createModelReviewer(model, { ...CONFIG, maxSteps: 2 }).reviewFile(input()),
    ).rejects.toThrow('without an accepted verdict')
    expect(calls).toHaveLength(4)
  })

  test('a deleted file is reviewed from its diff alone', async () => {
    const { model, calls } = scripted([submit('1', [KEPT, { ...BROKEN, violated: false }])])
    await createModelReviewer(model, CONFIG).reviewFile(input({ kind: 'deleted', content: null }))
    expect(shown(calls[0])).toContain('(deleted)')
  })
})
