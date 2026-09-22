import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { createModelAsker } from '../../../src/adapters/model/asker.ts'
import { DEFAULT_CONFIG } from '../../../src/core/config.ts'
import type { RepoReader } from '../../../src/core/ports.ts'

/**
 * The asker agent, driven by a scripted model rather than a real one — the same harness the
 * reviewer's tests use.
 *
 * What is worth checking here is mostly what it is NOT offered: this agent is read-only by
 * construction, and a write tool appearing in its list would be a real hole rather than a
 * cosmetic slip.
 */

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>

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
function scripted(steps: (GenerateResult | Error)[]) {
  const calls: CallOptions[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      const step = steps[calls.length - 1]
      if (step === undefined) throw new Error('the script ran out')
      if (step instanceof Error) throw step
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

const CONFIG = DEFAULT_CONFIG.ask
const REQUEST = { root: '/repo', payload: '## The question\nWhat calls this?', reader }

function names(call: CallOptions | undefined): string[] {
  return (call?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort()
}

describe('createModelAsker', () => {
  test('shows the model the payload it was given', async () => {
    const { model, calls } = scripted([text('Only `src/b.ts` does.')])
    await createModelAsker(model, CONFIG).ask(REQUEST)
    expect(JSON.stringify(calls[0]?.prompt ?? [])).toContain('What calls this?')
  })

  test('offers exactly the three read-only tools — no submit, no write', async () => {
    const { model, calls } = scripted([text('An answer.')])
    await createModelAsker(model, CONFIG).ask(REQUEST)
    expect(names(calls[0])).toEqual(['glob', 'grep', 'read_file'])
  })

  test('returns the answer, trimmed', async () => {
    const { model } = scripted([text('  Only `src/b.ts` does.\n')])
    expect(await createModelAsker(model, CONFIG).ask(REQUEST)).toBe('Only `src/b.ts` does.')
  })

  /** The point of giving it tools: go and look, then answer. */
  test('runs its tools against the repository, then answers', async () => {
    reads.length = 0
    const { model, calls } = scripted([
      toolCall('1', 'grep', { pattern: 'from "./a"' }),
      toolCall('2', 'read_file', { path: 'src/b.ts' }),
      text('`src/b.ts:2` is the only caller.'),
    ])
    const answer = await createModelAsker(model, CONFIG).ask(REQUEST)

    expect(answer).toBe('`src/b.ts:2` is the only caller.')
    expect(reads).toEqual(['src/b.ts'])
    // The read's result reached the model, numbered.
    expect(JSON.stringify(calls[2]?.prompt ?? [])).toContain('2\\texport const b = a')
  })

  test('stops at the step cap and answers with what it has', async () => {
    const { model, calls } = scripted([
      toolCall('1', 'glob', { pattern: '**/*' }),
      text('As far as I can tell, nothing calls it.'),
    ])
    await createModelAsker(model, { ...CONFIG, maxSteps: 2 }).ask(REQUEST)
    expect(calls).toHaveLength(2)
  })

  /**
   * The cap step must be one where answering is the only thing left to do. Otherwise a model
   * mid-search spends the last step on one more grep, and the run ends with nothing to say —
   * observed live, on a follow-up that needed a look around the repository.
   */
  test('forbids tool calls on the last step, so the cap step answers', async () => {
    const { model, calls } = scripted([
      toolCall('1', 'glob', { pattern: '**/*' }),
      toolCall('2', 'grep', { pattern: 'chart' }),
      text('It is drawn by the results page.'),
    ])
    await createModelAsker(model, { ...CONFIG, maxSteps: 3 }).ask(REQUEST)

    expect(calls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(calls[1]?.toolChoice).toEqual({ type: 'auto' })
    expect(calls[2]?.toolChoice).toEqual({ type: 'none' })
    // Still defined, though: dropping the definitions from a conversation full of calls to them
    // is what Gemini refused live ("Corrupted thought signature"), or answered with a tool call
    // regardless.
    expect(names(calls[2])).toEqual(['glob', 'grep', 'read_file'])
    // And said in words, since Gemini ignores `toolChoice: 'none'` too.
    expect(JSON.stringify(calls[2]?.prompt.at(-1))).toContain('out of tool calls')
    expect(JSON.stringify(calls[1]?.prompt ?? [])).not.toContain('out of tool calls')
  })

  test('says how the run ended when it answers nothing', async () => {
    const { model } = scripted([text('   '), text('   ')])
    await expect(createModelAsker(model, CONFIG).ask(REQUEST)).rejects.toThrow(
      /after 1 step.*finish reason: stop/,
    )
  })

  test('a run that answers nothing is a failure the caller can render', async () => {
    const { model } = scripted([text('   '), text('   ')])
    await expect(createModelAsker(model, CONFIG).ask(REQUEST)).rejects.toThrow('without answering')
  })

  test('a model failure becomes a rejection, after one retry', async () => {
    const { model, calls } = scripted([new Error('502 from upstream'), text('An answer.')])
    expect(await createModelAsker(model, CONFIG).ask(REQUEST)).toBe('An answer.')
    expect(calls).toHaveLength(2)
  })

  test('two failures in a row reject', async () => {
    const { model } = scripted([new Error('502 from upstream'), new Error('502 from upstream')])
    await expect(createModelAsker(model, CONFIG).ask(REQUEST)).rejects.toThrow('502 from upstream')
  })
})
