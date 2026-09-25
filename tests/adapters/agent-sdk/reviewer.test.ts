import { describe, expect, test } from 'bun:test'
import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  buildSubmitTool,
  connectReviewer,
  REVIEW_SYSTEM_PROMPT,
  reviewPrompt,
} from '../../../src/adapters/agent-sdk/reviewer.ts'
import type { ReviewInput } from '../../../src/core/ports.ts'
import type { Finding, ReviewerUpdate } from '../../../src/core/types.ts'

/**
 * The reviewer adapter, driven by a scripted `query()` rather than a real subprocess. The fake
 * calls `submit_findings` through the in-process MCP server the adapter registers — the same
 * handler the real CLI reaches — so what is exercised is the adapter's own accept path.
 */

const ROOT = '/repo'

const INPUT: ReviewInput = {
  root: ROOT,
  files: [
    { path: 'src/a.ts', kind: 'modified' },
    { path: 'src/b.ts', kind: 'modified', previousPath: 'src/old.ts' },
  ],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+changed',
}

const FINDING = {
  path: 'src/a.ts',
  startLine: 2,
  endLine: 3,
  severity: 'high' as const,
  title: 'Dropped promise',
  message: 'Its rejection is never handled.',
}

type Submission = { findings: (typeof FINDING & { cause?: string })[] }
type ToolResult = { content: { text: string }[]; isError?: boolean }

/** Calls a tool the adapter registered, through the MCP SDK's own registry. */
function callTool(options: Options, args: Submission): Promise<ToolResult> {
  const server = options.mcpServers?.review as unknown as {
    instance: {
      _registeredTools: Record<string, { handler: (args: Submission) => Promise<ToolResult> }>
    }
  }
  const registered = server.instance._registeredTools.submit_findings
  if (registered === undefined) throw new Error('submit_findings is not registered')
  return registered.handler(args)
}

const result = (subtype: 'success' | 'error_max_turns' = 'success') =>
  ({ type: 'result', subtype }) as unknown as SDKMessage

/**
 * A `query()` that reads the prompt, runs `script` against the options it was given, then ends
 * with a result message.
 */
function scriptedQuery(
  script: (options: Options) => Promise<void>,
  end: SDKMessage | null = result(),
) {
  const calls: { options: Options; prompt: SDKUserMessage[] }[] = []
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const call = { options: params.options, prompt: [] as SDKUserMessage[] }
    calls.push(call)
    const iterator = params.prompt[Symbol.asyncIterator]()
    return (async function* () {
      const first = await iterator.next()
      if (!first.done) call.prompt.push(first.value)
      await script(params.options)
      if (end !== null) yield end
    })()
  }) as unknown as NonNullable<Parameters<typeof connectReviewer>[0]['queryFn']>
  return { queryFn, calls }
}

const reviewer = (queryFn: Parameters<typeof connectReviewer>[0]['queryFn'], timeoutMs = 5000) =>
  connectReviewer({ timeoutMs, maxTurns: 30, queryFn, reservedPaths: ['/repo/.turnstile'] })

describe('connectReviewer', () => {
  test('returns the accepted submission, with every reviewed file present', async () => {
    const { queryFn } = scriptedQuery(async (options) => {
      await callTool(options, { findings: [FINDING] })
    })
    const byFile = await reviewer(queryFn).review(INPUT)
    expect(byFile).toEqual(
      new Map<string, Finding[]>([
        ['src/a.ts', [FINDING]],
        ['src/b.ts', []],
      ]),
    )
  })

  test('a refused submission is explained, and the corrected one is taken', async () => {
    const replies: ToolResult[] = []
    const { queryFn } = scriptedQuery(async (options) => {
      replies.push(await callTool(options, { findings: [{ ...FINDING, path: 'src/caller.ts' }] }))
      replies.push(
        await callTool(options, {
          findings: [{ ...FINDING, path: 'src/caller.ts', cause: 'src/a.ts' }],
        }),
      )
    })
    const byFile = await reviewer(queryFn).review(INPUT)
    expect(replies[0]?.isError).toBe(true)
    expect(replies[0]?.content[0]?.text).toContain('cause')
    expect(byFile.get('src/a.ts')).toEqual([{ ...FINDING, path: 'src/caller.ts' }])
  })

  test('a run that ends without submitting fails, saying so', async () => {
    const { queryFn } = scriptedQuery(async () => {}, result('error_max_turns'))
    await expect(reviewer(queryFn).review(INPUT)).rejects.toThrow('error_max_turns')
  })

  test('a run that never finishes is abandoned at the timeout', async () => {
    const queryFn = ((params: { options: Options }) =>
      (async function* () {
        await new Promise((_, reject) => {
          params.options.abortController?.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        })
      })()) as unknown as Parameters<typeof connectReviewer>[0]['queryFn']
    await expect(reviewer(queryFn, 20).review(INPUT)).rejects.toThrow('timed out')
  })

  test('reports each step, and each call once, as the run makes it', async () => {
    const toolUse = (id: string, name: string, input: unknown) =>
      ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input }] },
      }) as unknown as SDKMessage
    const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) =>
      (async function* () {
        await params.prompt[Symbol.asyncIterator]().next()
        yield { type: 'system', subtype: 'init' } as unknown as SDKMessage
        yield toolUse('t1', 'Read', { file_path: `${ROOT}/src/a.ts` })
        // The same block again, as the SDK can send it: counted once.
        yield toolUse('t1', 'Read', { file_path: `${ROOT}/src/a.ts` })
        yield toolUse('t2', 'Grep', { pattern: 'dropped' })
        yield toolUse('t3', 'mcp__review__submit_findings', { findings: [] })
        await callTool(params.options, { findings: [] })
        yield result()
      })()) as unknown as Parameters<typeof connectReviewer>[0]['queryFn']

    const updates: ReviewerUpdate[] = []
    await reviewer(queryFn).review(INPUT, (update) => updates.push(update))

    expect(updates).toEqual([
      { step: 'starting', toolCalls: 0, current: null },
      { step: 'investigating', toolCalls: 0, current: null },
      { step: 'investigating', toolCalls: 1, current: 'reading src/a.ts' },
      { step: 'investigating', toolCalls: 2, current: 'searching for dropped' },
      { step: 'submitting', toolCalls: 2, current: 'submitting findings' },
    ])
  })

  test('a progress listener that throws does not cost the review', async () => {
    const { queryFn } = scriptedQuery(async (options) => {
      await callTool(options, { findings: [] })
    })
    const byFile = await reviewer(queryFn).review(INPUT, () => {
      throw new Error('listener broke')
    })
    expect([...byFile.keys()]).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('runs read-only, out of the session history, with the repository’s own setup', async () => {
    const { queryFn, calls } = scriptedQuery(async (options) => {
      await callTool(options, { findings: [] })
    })
    await reviewer(queryFn).review(INPUT)
    const options = calls[0]?.options
    expect(options?.cwd).toBe(ROOT)
    expect(options?.persistSession).toBe(false)
    expect(options?.settingSources).toBeUndefined()
    expect(options?.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Skill'])
    expect(options?.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Agent']))
    expect(options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: REVIEW_SYSTEM_PROMPT,
    })
    expect(calls[0]?.prompt[0]?.message.content).toBe(reviewPrompt(INPUT))
  })

  test('lets reads and read-only commands through, and nothing else', async () => {
    const { queryFn, calls } = scriptedQuery(async (options) => {
      await callTool(options, { findings: [] })
    })
    await reviewer(queryFn).review(INPUT)
    const canUseTool = calls[0]?.options.canUseTool as CanUseTool
    const decide = async (name: string, input: Record<string, unknown>) =>
      (await canUseTool(name, input, { signal: new AbortController().signal } as never))?.behavior

    expect(await decide('Read', { file_path: '/repo/src/a.ts' })).toBe('allow')
    expect(await decide('Bash', { command: 'git log --oneline -5' })).toBe('allow')
    expect(await decide('mcp__review__submit_findings', { findings: [] })).toBe('allow')
    expect(await decide('Bash', { command: 'rm -rf src' })).toBe('deny')
    expect(await decide('Bash', { command: 'echo x > src/a.ts' })).toBe('deny')
    expect(await decide('WebFetch', { url: 'https://example.com' })).toBe('deny')
    expect(await decide('Read', { file_path: '/repo/.turnstile/notes.json' })).toBe('deny')
  })
})

describe('buildSubmitTool', () => {
  test('makes absolute paths relative to the root, and takes only the first answer', async () => {
    const accepted: Map<string, Finding[]>[] = []
    const submit = buildSubmitTool(ROOT, ['src/a.ts'], (byFile) => accepted.push(byFile))
    await submit.handler({ findings: [{ ...FINDING, path: '/repo/src/a.ts' }] }, {})
    const second = await submit.handler({ findings: [] }, {})
    expect(accepted).toEqual([new Map([['src/a.ts', [FINDING]]])])
    expect(second.content[0]).toMatchObject({ text: 'Already submitted.' })
  })
})

describe('reviewPrompt', () => {
  test('lists the files, renames included, ahead of the diff', () => {
    const prompt = reviewPrompt(INPUT)
    expect(prompt).toContain('  - src/a.ts (modified)')
    expect(prompt).toContain('  - src/b.ts (modified, from src/old.ts)')
    expect(prompt.endsWith(INPUT.diff)).toBe(true)
  })
})
