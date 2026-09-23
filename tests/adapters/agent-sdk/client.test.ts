import { describe, expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Options,
  Query,
  query as realQuery,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  agentEventsFromSessionMessages,
  buildPlanTool,
  buildWriteTool,
  connectAgentSdk,
} from '../../../src/adapters/agent-sdk/client.ts'
import type { AutoModeVerdict } from '../../../src/core/autoMode.ts'
import type { AutoApprover } from '../../../src/core/ports.ts'
import type { AgentEvent } from '../../../src/core/types.ts'

/**
 * A fake `query()` that never spawns a subprocess or calls a real model: it hands back an
 * async generator the test pushes scripted `SDKMessage`s into, and records everything sent
 * into the streaming-input side and every `Options` it was called with.
 */
/** Auto-mode answering every call with `verdict`, recording what it was asked. */
function fakeApprover(
  verdict:
    | AutoModeVerdict
    | ((toolName: string, input: Record<string, unknown>) => AutoModeVerdict) = { kind: 'allow' },
) {
  const asked: { toolName: string; input: Record<string, unknown>; signal?: AbortSignal }[] = []
  const approver: AutoApprover = {
    verdict: async (toolName, input, signal) => {
      asked.push({ toolName, input, ...(signal === undefined ? {} : { signal }) })
      return typeof verdict === 'function' ? verdict(toolName, input) : verdict
    },
  }
  return { approver, asked }
}

const FLAGGED: AutoModeVerdict = {
  kind: 'flag',
  fired: [{ rule: { id: 'push', text: 'Pushes to a remote' }, probability: 0.91 }],
}

function fakeQueryFn() {
  const calls: { options: Options }[] = []
  const sent: SDKUserMessage[] = []
  const setPermissionModeCalls: string[] = []
  let pushMessage: (m: SDKMessage) => void = () => {}
  let killProcess: (error: Error) => void = () => {}
  let contextUsage = { totalTokens: 0, maxTokens: 0, rawMaxTokens: 0, percentage: 0 }

  const queryFn = ((params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }) => {
    calls.push({ options: params.options ?? {} })

    if (typeof params.prompt !== 'string') {
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
          sent.push(message)
        }
      })()
    }

    const pending: SDKMessage[] = []
    let wake: (() => void) | null = null
    let died: Error | null = null
    pushMessage = (m) => {
      pending.push(m)
      wake?.()
      wake = null
    }
    // The subprocess dying: the real SDK's iterator throws "Claude Code process terminated by
    // signal …" (or "… exited with code …").
    killProcess = (error) => {
      died = error
      wake?.()
      wake = null
    }

    const gen = (async function* () {
      for (;;) {
        while (pending.length === 0 && died === null) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (died !== null) throw died
        yield pending.shift() as SDKMessage
      }
    })()

    return Object.assign(gen, {
      interrupt: async () => undefined,
      close: () => {},
      getContextUsage: async () => ({ categories: [], gridRows: [], ...contextUsage }),
      setPermissionMode: async (mode: string) => {
        setPermissionModeCalls.push(mode)
      },
      setMcpPermissionModeOverride: async () => ({}),
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      setMcpServers: async () => ({}),
    }) as unknown as Query
  }) as unknown as typeof realQuery

  return {
    queryFn,
    calls,
    push: (m: SDKMessage) => pushMessage(m),
    /** Kill the most recently opened query's subprocess. */
    kill: (error: Error) => killProcess(error),
    sentPrompts: () => sent,
    setContextUsage: (usage: typeof contextUsage) => {
      contextUsage = usage
    },
    setPermissionModeCalls,
  }
}

function initMessage(sessionId: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '0.0.0',
    cwd: '/repo',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'u-init',
    session_id: sessionId,
    ...overrides,
  } as unknown as SDKMessage
}

function statusMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    status: null,
    uuid: 'u-status',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-result',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    uuid: `u-${id}`,
    session_id: 'sess-1',
  } as unknown as SDKMessage
}

function toolResultMessage(toolUseId: string, isError = false): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '', is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: `u-result-${toolUseId}`,
    session_id: 'sess-1',
  } as unknown as SDKMessage
}

function taskStartedMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Investigate widget bug',
    uuid: 'u-task-started',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function taskProgressMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Investigate widget bug',
    usage: { total_tokens: 100, tool_uses: 3, duration_ms: 5000 },
    uuid: 'u-task-progress',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function taskUpdatedMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-1',
    patch: { status: 'completed' },
    uuid: 'u-task-updated',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function taskNotificationMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status: 'completed',
    output_file: '/tmp/out.jsonl',
    summary: 'Found and fixed the widget bug.',
    uuid: 'u-task-notification',
    session_id: 'sess-1',
    ...overrides,
  } as unknown as SDKMessage
}

function historyUserText(uuid: string, text: string): SessionMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'sess-old',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage
}

function historyAssistantText(uuid: string, text: string): SessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-old',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage
}

function historyThinking(uuid: string, thinking: string): SessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-old',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking, signature: 'sig' }] },
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage
}

function historyToolUse(
  uuid: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): SessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-old',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage
}

function historyToolResult(uuid: string, toolUseId: string, isError = false): SessionMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'sess-old',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '', is_error: isError }],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage
}

describe('connectAgentSdk', () => {
  /**
   * Confirmed directly against a real `query()`: in streaming-input mode the subprocess does
   * not emit `system/init` (or assign/reveal a session id at all) until the first message is
   * actually pulled off the prompt iterable — which cannot happen before `start()` resolves,
   * since nothing has been prompted yet. `start()` must therefore resolve immediately, without
   * waiting on anything the fake pushes, using an id chosen up front and passed as
   * `Options.sessionId` — which is what makes that id valid once the SDK does create the
   * conversation, not a guess.
   */
  test('start() resolves immediately to the caller-chosen id, passed through as Options.sessionId', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const sessionId = await client.start('chosen-id')
    expect(sessionId).toBe('chosen-id')
    expect(fake.calls[0]?.options.sessionId).toBe('chosen-id')
    expect(fake.calls[0]?.options.resume).toBeUndefined()
  })

  test('loadSession(id) resolves immediately to that same id, passed through as Options.resume', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      getSessionMessagesFn: async () => [],
    })

    const resolved = await client.loadSession('sess-old')
    expect(resolved).toBe('sess-old')
    expect(fake.calls[0]?.options.resume).toBe('sess-old')
    expect(fake.calls[0]?.options.sessionId).toBeUndefined()
  })

  test('loadSession replays stored history as ordered AgentEvents before opening the query', async () => {
    const fake = fakeQueryFn()
    const events: AgentEvent[] = []
    const history: SessionMessage[] = [
      historyUserText('u-1', 'fix the widget bug'),
      historyAssistantText('u-2', 'On it.'),
      historyToolUse('u-3', 'toolu-1', 'Bash', { command: 'ls' }),
      historyToolResult('u-4', 'toolu-1'),
    ]
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      getSessionMessagesFn: async (sessionId, options) => {
        expect(sessionId).toBe('sess-old')
        expect(options).toEqual({ dir: '/repo' })
        return history
      },
    })

    const resolved = await client.loadSession('sess-old')

    expect(events).toEqual([
      { kind: 'user', text: 'fix the widget bug' },
      { kind: 'assistant', text: 'On it.' },
      { kind: 'tool', id: 'toolu-1', title: 'ls', toolKind: 'execute', status: 'pending' },
      { kind: 'tool', id: 'toolu-1', title: 'ls', toolKind: 'execute', status: 'completed' },
    ])
    expect(resolved).toBe('sess-old')
    expect(fake.calls[0]?.options.resume).toBe('sess-old')
  })

  test('loadSession surfaces a history-load failure as one agent-error but still opens the query', async () => {
    const fake = fakeQueryFn()
    const events: AgentEvent[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      getSessionMessagesFn: async () => {
        throw new Error('disk on fire')
      },
    })

    const resolved = await client.loadSession('sess-old')

    expect(events).toEqual([{ kind: 'agent-error', message: 'disk on fire' }])
    expect(resolved).toBe('sess-old')
    expect(fake.calls[0]?.options.resume).toBe('sess-old')
  })

  test('prompt() sends the exact text and resolves to the result stop_reason', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('add a test')
    fake.push(resultMessage({ stop_reason: 'end_turn' }))
    expect(await prompted).toBe('end_turn')

    for (let i = 0; i < 200 && fake.sentPrompts().length === 0; i++) await Bun.sleep(2)
    expect(fake.sentPrompts()).toHaveLength(1)
    const sentMessage = fake.sentPrompts()[0]?.message as { content: string }
    expect(sentMessage.content).toBe('add a test')
  })

  test('a tool_use block followed by its tool_result translates to pending then completed', async () => {
    const fake = fakeQueryFn()
    const events: {
      kind: string
      status?: string
      id?: string
      title?: string
      toolKind?: string
    }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('run ls')
    fake.push(toolUseMessage('t1', 'Bash', { command: 'ls' }))
    fake.push(toolResultMessage('t1'))
    fake.push(resultMessage())
    await prompted

    const toolEvents = events.filter((e) => e.kind === 'tool')
    expect(toolEvents).toEqual([
      { kind: 'tool', id: 't1', status: 'pending', title: 'ls', toolKind: 'execute' },
      { kind: 'tool', id: 't1', status: 'completed', title: 'ls', toolKind: 'execute' },
    ])
  })

  test('a failed tool_result translates to a failed status, carrying the same toolKind', async () => {
    const fake = fakeQueryFn()
    const events: {
      kind: string
      id?: string
      status?: string
      title?: string
      toolKind?: string
    }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('run a bad command')
    fake.push(toolUseMessage('t1', 'Bash', { command: 'nope' }))
    fake.push(toolResultMessage('t1', true))
    fake.push(resultMessage())
    await prompted

    expect(events.filter((e) => e.kind === 'tool')).toEqual([
      { kind: 'tool', id: 't1', status: 'pending', title: 'nope', toolKind: 'execute' },
      { kind: 'tool', id: 't1', status: 'failed', title: 'nope', toolKind: 'execute' },
    ])
  })

  test('a tool_result for an unmatched id falls back to toolKind "other"', async () => {
    const fake = fakeQueryFn()
    const events: {
      kind: string
      id?: string
      status?: string
      title?: string
      toolKind?: string
    }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('go')
    fake.push(toolResultMessage('unknown-id'))
    fake.push(resultMessage())
    await prompted

    expect(events.filter((e) => e.kind === 'tool')).toEqual([
      { kind: 'tool', id: 'unknown-id', status: 'completed', title: '', toolKind: 'other' },
    ])
  })

  test('an Agent tool_use is labeled with its description, not the bare tool name', async () => {
    const fake = fakeQueryFn()
    const events: {
      kind: string
      id?: string
      title?: string
      toolKind?: string
      status?: string
    }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('investigate')
    fake.push(
      toolUseMessage('t1', 'Agent', {
        description: 'Investigate widget bug',
        prompt: 'find the bug',
      }),
    )
    fake.push(resultMessage())
    await prompted

    expect(events.filter((e) => e.kind === 'tool')).toEqual([
      {
        kind: 'tool',
        id: 't1',
        status: 'pending',
        title: 'Investigate widget bug',
        toolKind: 'agent',
      },
    ])
  })

  describe('subagent task lifecycle', () => {
    test('task_started emits a running subagent event', async () => {
      const fake = fakeQueryFn()
      const events: Record<string, unknown>[] = []
      const client = connectAgentSdk({
        cwd: '/repo',
        onEvent: (event) => events.push(event as never),
        writeFile: async () => ({ decision: 'allow', fileContent: '' }),
        requestPlanApproval: async () => ({ decision: 'allow' }),
        queryFn: fake.queryFn,
      })

      const started = client.start('sess-1')
      fake.push(initMessage('sess-1'))
      await started

      const prompted = client.prompt('go')
      fake.push(
        taskStartedMessage({
          task_id: 'task-1',
          tool_use_id: 't1',
          description: 'Investigate widget bug',
          subagent_type: 'general',
        }),
      )
      fake.push(resultMessage())
      await prompted

      expect(events.filter((e) => e.kind === 'subagent')).toEqual([
        {
          kind: 'subagent',
          taskId: 'task-1',
          toolUseId: 't1',
          status: 'running',
          description: 'Investigate widget bug',
          subagentType: 'general',
          lastToolName: null,
          toolUses: null,
          summary: null,
        },
      ])
    })

    test('a task_started marked skip_transcript emits nothing', async () => {
      const fake = fakeQueryFn()
      const events: Record<string, unknown>[] = []
      const client = connectAgentSdk({
        cwd: '/repo',
        onEvent: (event) => events.push(event as never),
        writeFile: async () => ({ decision: 'allow', fileContent: '' }),
        requestPlanApproval: async () => ({ decision: 'allow' }),
        queryFn: fake.queryFn,
      })

      const started = client.start('sess-1')
      fake.push(initMessage('sess-1'))
      await started

      const prompted = client.prompt('go')
      fake.push(taskStartedMessage({ skip_transcript: true }))
      fake.push(resultMessage())
      await prompted

      expect(events.filter((e) => e.kind === 'subagent')).toEqual([])
    })

    test('task_progress carries the running heartbeat', async () => {
      const fake = fakeQueryFn()
      const events: Record<string, unknown>[] = []
      const client = connectAgentSdk({
        cwd: '/repo',
        onEvent: (event) => events.push(event as never),
        writeFile: async () => ({ decision: 'allow', fileContent: '' }),
        requestPlanApproval: async () => ({ decision: 'allow' }),
        queryFn: fake.queryFn,
      })

      const started = client.start('sess-1')
      fake.push(initMessage('sess-1'))
      await started

      const prompted = client.prompt('go')
      fake.push(
        taskProgressMessage({
          task_id: 'task-1',
          last_tool_name: 'Bash',
          usage: { total_tokens: 100, tool_uses: 4, duration_ms: 6000 },
        }),
      )
      fake.push(resultMessage())
      await prompted

      expect(events.filter((e) => e.kind === 'subagent')).toEqual([
        {
          kind: 'subagent',
          taskId: 'task-1',
          toolUseId: null,
          status: 'running',
          description: 'Investigate widget bug',
          subagentType: null,
          lastToolName: 'Bash',
          toolUses: 4,
          summary: null,
        },
      ])
    })

    test('task_updated patches only the fields it carries', async () => {
      const fake = fakeQueryFn()
      const events: Record<string, unknown>[] = []
      const client = connectAgentSdk({
        cwd: '/repo',
        onEvent: (event) => events.push(event as never),
        writeFile: async () => ({ decision: 'allow', fileContent: '' }),
        requestPlanApproval: async () => ({ decision: 'allow' }),
        queryFn: fake.queryFn,
      })

      const started = client.start('sess-1')
      fake.push(initMessage('sess-1'))
      await started

      const prompted = client.prompt('go')
      fake.push(taskUpdatedMessage({ task_id: 'task-1', patch: { status: 'failed' } }))
      fake.push(resultMessage())
      await prompted

      expect(events.filter((e) => e.kind === 'subagent')).toEqual([
        {
          kind: 'subagent',
          taskId: 'task-1',
          toolUseId: null,
          status: 'failed',
          description: null,
          subagentType: null,
          lastToolName: null,
          toolUses: null,
          summary: null,
        },
      ])
    })

    test('task_notification emits a terminal event with the summary', async () => {
      const fake = fakeQueryFn()
      const events: Record<string, unknown>[] = []
      const client = connectAgentSdk({
        cwd: '/repo',
        onEvent: (event) => events.push(event as never),
        writeFile: async () => ({ decision: 'allow', fileContent: '' }),
        requestPlanApproval: async () => ({ decision: 'allow' }),
        queryFn: fake.queryFn,
      })

      const started = client.start('sess-1')
      fake.push(initMessage('sess-1'))
      await started

      const prompted = client.prompt('go')
      fake.push(
        taskNotificationMessage({
          task_id: 'task-1',
          status: 'completed',
          summary: 'Found and fixed the widget bug.',
        }),
      )
      fake.push(resultMessage())
      await prompted

      expect(events.filter((e) => e.kind === 'subagent')).toEqual([
        {
          kind: 'subagent',
          taskId: 'task-1',
          toolUseId: null,
          status: 'completed',
          description: null,
          subagentType: null,
          lastToolName: null,
          toolUses: null,
          summary: 'Found and fixed the widget bug.',
        },
      ])
    })
  })

  test('stop() clears the pending-tool map, so a residual tool_result falls back to "other"', async () => {
    const fake = fakeQueryFn()
    const events: {
      kind: string
      id?: string
      status?: string
      title?: string
      toolKind?: string
    }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    // A tool_use lands but never gets a matching tool_result — as if the call was
    // interrupted mid-flight.
    client.prompt('run something slow')
    fake.push(toolUseMessage('t1', 'Bash', { command: 'sleep 100' }))
    for (
      let i = 0;
      i < 200 && !events.some((e) => e.kind === 'tool' && e.status === 'pending');
      i++
    ) {
      await Bun.sleep(2)
    }

    client.stop()

    // A tool_result for that same id arrives afterward (e.g. buffered output draining from
    // the now-stopped subprocess) — it must not resolve from the entry `stop()` already
    // cleared.
    fake.push(toolResultMessage('t1'))
    for (
      let i = 0;
      i < 200 && !events.some((e) => e.kind === 'tool' && e.status === 'completed');
      i++
    ) {
      await Bun.sleep(2)
    }

    const completed = events.find((e) => e.kind === 'tool' && e.status === 'completed')
    expect(completed).toEqual({
      kind: 'tool',
      id: 't1',
      status: 'completed',
      title: '',
      toolKind: 'other',
    })
  })

  test('canUseTool: a call auto-mode allows runs with no prompt, and auto-mode is asked about each', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string }[] = []
    const { approver, asked } = fakeApprover()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const bashResult = await canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)
    const readResult = await canUseTool('Read', { file_path: '/repo/src/index.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 't2',
      requestId: 'r2',
    } as never)
    const mcpResult = await canUseTool('mcp__plugin_claude-mem_mcp-search__get_observations', {}, {
      signal: new AbortController().signal,
      toolUseID: 't3',
      requestId: 'r3',
    } as never)

    expect(bashResult).toEqual({ behavior: 'allow' })
    expect(readResult).toEqual({ behavior: 'allow' })
    expect(mcpResult).toEqual({ behavior: 'allow' })
    expect(events.some((e) => e.kind === 'permission')).toBe(false)
    expect(asked.map((call) => call.toolName)).toEqual([
      'Bash',
      'Read',
      'mcp__plugin_claude-mem_mcp-search__get_observations',
    ])
    expect(asked[0]?.input).toEqual({ command: 'git status' })
    // The SDK's own signal is passed through, so an interrupt stops the judge too.
    expect(asked[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  /**
   * The bug this catches: `AskUserQuestion` is just another tool name to auto-mode (and was to
   * the denylist before it), so without a special case it used to fall straight into the
   * auto-allow path above — `{ behavior: 'allow' }`, no `updatedInput`,
   * no human ever shown the question — instead of blocking on a `question` event the way the
   * Agent SDK's "handle clarifying questions" guide expects.
   */
  test('canUseTool: AskUserQuestion blocks on a question event rather than auto-allowing', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string; questions?: unknown }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const rawQuestions = [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
        multiSelect: false,
      },
    ]

    const resultPromise = canUseTool('AskUserQuestion', { questions: rawQuestions }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)

    for (let i = 0; i < 200 && events.filter((e) => e.kind === 'question').length === 0; i++) {
      await Bun.sleep(2)
    }
    const question = events.find((e) => e.kind === 'question')
    if (question === undefined) throw new Error('no question event was emitted')
    expect(question.questions).toEqual(rawQuestions)
    expect(events.some((e) => e.kind === 'permission')).toBe(false)

    client.answerQuestion(question.id ?? '', { 'How should I format the output?': 'Summary' })

    expect(await resultPromise).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: rawQuestions,
        answers: { 'How should I format the output?': 'Summary' },
      },
    })
    expect(events.some((e) => e.kind === 'question-resolved')).toBe(true)
  })

  test('canUseTool permission: a flagged call prompts naming the statement, answerPermission unblocks it', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string; title?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: fakeApprover(FLAGGED).approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const resultPromise = canUseTool('Bash', { command: 'git push' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
      title: 'Claude wants to run a Bash command',
    } as never)

    for (let i = 0; i < 200 && events.filter((e) => e.kind === 'permission').length === 0; i++) {
      await Bun.sleep(2)
    }
    const permission = events.find((e) => e.kind === 'permission')
    if (permission === undefined) throw new Error('no permission event was emitted')
    // Turnstile's own sentence wins over the bridge's vaguer one, and — the point of it — the
    // reader is shown the command they are being asked to approve.
    expect(permission).toMatchObject({
      title: 'Run this command?',
      subject: 'git push',
      flagged: [{ text: 'Pushes to a remote', probability: 0.91 }],
    })
    expect((permission as { reason?: string }).reason).toContain('Pushes to a remote')

    client.answerPermission(permission.id ?? '', 'allow')
    expect(await resultPromise).toEqual({ behavior: 'allow' })
    expect(events.some((e) => e.kind === 'permission-resolved')).toBe(true)
  })

  test('canUseTool permission: a sandbox escape names the command, not just "Allow Bash?"', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string; title?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: fakeApprover(FLAGGED).approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    // The real shape observed live: the bridge leaves `title` undefined, which is exactly what
    // used to collapse every one of these into a bare "Allow Bash?".
    const resultPromise = canUseTool(
      'Bash',
      {
        command: 'bun install --frozen-lockfile',
        description: 'Install dependencies',
        dangerouslyDisableSandbox: true,
      },
      {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
        blockedPath: '/Users/x/.bun/install/cache',
      } as never,
    )

    for (let i = 0; i < 200 && events.filter((e) => e.kind === 'permission').length === 0; i++) {
      await Bun.sleep(2)
    }
    const permission = events.find((e) => e.kind === 'permission')
    if (permission === undefined) throw new Error('no permission event was emitted')
    expect(permission).toMatchObject({
      title: 'Run this command?',
      subject: 'bun install --frozen-lockfile',
      description: 'Install dependencies',
    })
    expect((permission as { reason?: string }).reason).toContain('/Users/x/.bun/install/cache')

    client.answerPermission(permission.id ?? '', 'deny')
    expect(await resultPromise).toEqual({
      behavior: 'deny',
      message: 'Denied by the user.',
    })
  })

  test('canUseTool: a denied permission resolves as behavior deny', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: fakeApprover(FLAGGED).approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const resultPromise = canUseTool('Bash', { command: 'sudo rm -rf /tmp/x' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)

    for (let i = 0; i < 200 && events.filter((e) => e.kind === 'permission').length === 0; i++) {
      await Bun.sleep(2)
    }
    const permission = events.find((e) => e.kind === 'permission')
    if (permission === undefined) throw new Error('no permission event was emitted')

    client.answerPermission(permission.id ?? '', 'deny')
    const result = await resultPromise
    if (result === null) throw new Error('expected a permission result')
    expect(result.behavior).toBe('deny')
  })

  /** OS-enforced: text matching alone let `grep -r` and `python open()` read a denied file. */
  test('protected dirs become Read/Edit deny rules and a sandbox that denies them to Bash', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      protectedDirs: ['/home/me/.turnstile'],
    })
    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started
    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)

    const options = fake.calls[0]?.options
    expect(options?.settings).toEqual({
      permissions: { deny: ['Read(//home/me/.turnstile/**)', 'Edit(//home/me/.turnstile/**)'] },
    })
    expect(options?.sandbox).toMatchObject({
      enabled: true,
      // Every Bash call must still reach canUseTool, or auto-mode stops applying to it.
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowWrite: ['/'],
        denyRead: ['/home/me/.turnstile'],
        denyWrite: ['/home/me/.turnstile'],
      },
    })
  })

  test('no protected dirs leaves the sandbox off', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })
    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started
    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    expect(fake.calls[0]?.options.sandbox).toBeUndefined()
  })

  /** Auto-mode not set up is not auto-mode saying yes. */
  test('canUseTool: with no auto-mode, every ordinary call is put to the human', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      protectedDirs: ['/home/me/.turnstile'],
    })
    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started
    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const result = canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)
    for (let i = 0; i < 200 && !events.some((e) => e.kind === 'permission'); i++) await Bun.sleep(2)
    const permission = events.find((e) => e.kind === 'permission')
    if (permission === undefined) throw new Error('no permission event was emitted')
    expect((permission as { reason?: string }).reason).toContain('not set up')
    client.answerPermission(permission.id ?? '', 'deny')
    expect(await result).toMatchObject({ behavior: 'deny' })
  })

  /** The review is only independent if the agent cannot read the rules it is assessed against. */
  test('canUseTool: any call naming a reserved path is denied outright, the write tool included', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string }[] = []
    const { approver, asked } = fakeApprover()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      reservedPaths: ['.turnstile', '/shared/rules'],
      autoApprover: approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')
    const call = (tool: string, input: Record<string, unknown>) =>
      canUseTool(tool, input, {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
      } as never)

    for (const [tool, input] of [
      ['Bash', { command: 'cd ~/.turnstile/rules && cat *.md' }],
      ['Read', { file_path: '/Users/me/.turnstile/rules/-repo/a.md' }],
      ['Grep', { pattern: 'x', path: '/shared/rules' }],
      ['mcp__turnstile__propose_edit', { path: '.turnstile/rules/a.md', new_text: 'x' }],
    ] as const) {
      expect(await call(tool, input)).toMatchObject({ behavior: 'deny' })
    }
    // Nobody was asked: there is no case for letting it through.
    expect(events.filter((event) => event.kind === 'permission')).toEqual([])
    // Nor was auto-mode: no statement the user writes can let one through.
    expect(asked).toEqual([])
    expect(await call('Read', { file_path: '/repo/src/a.ts' })).toEqual({ behavior: 'allow' })
  })

  test('canUseTool: auto-mode that cannot answer puts the call to the human, saying why', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; id?: string; reason?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: fakeApprover({ kind: 'unavailable', reason: 'TYPESAFE_API_KEY is not set' })
        .approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await Bun.sleep(2)
    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const resultPromise = canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)

    for (let i = 0; i < 200 && events.filter((e) => e.kind === 'permission').length === 0; i++) {
      await Bun.sleep(2)
    }
    const permission = events.find((e) => e.kind === 'permission')
    if (permission === undefined) throw new Error('no permission event was emitted')
    expect(permission.reason).toContain('TYPESAFE_API_KEY is not set')

    client.answerPermission(permission.id ?? '', 'allow')
    expect(await resultPromise).toEqual({ behavior: 'allow' })
  })

  /**
   * Confirmed open SDK bug (anthropics/claude-agent-sdk-typescript#366): interrupting before
   * any assistant content streamed yields `subtype: 'error_during_execution'`, `stop_reason:
   * null` — reproduced directly against the real SDK in this project's own Phase-0 spike.
   * `cancel()` must make the adapter treat that specific shape as a clean cancellation, not an
   * `agent-error`, since the query itself recovers fine for the next prompt.
   */
  test('cancel() during a turn: the resulting error_during_execution resolves cleanly, not as agent-error', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('count to 100')
    await client.cancel()
    fake.push(
      resultMessage({
        subtype: 'error_during_execution',
        stop_reason: null,
        is_error: true,
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
      }),
    )

    await prompted
    expect(events.some((e) => e.kind === 'agent-error')).toBe(false)
  })

  test('an error_during_execution NOT preceded by our own cancel() is surfaced as agent-error', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; message?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const prompted = client.prompt('do something')
    fake.push(
      resultMessage({
        subtype: 'error_during_execution',
        stop_reason: null,
        is_error: true,
        errors: ['boom'],
      }),
    )
    await prompted

    expect(events.some((e) => e.kind === 'agent-error')).toBe(true)
  })

  test('disallows Edit and Write, and registers the write tool as an mcp server', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const options = fake.calls[0]?.options
    expect(options?.disallowedTools).toEqual(['Edit', 'Write'])
    expect(Object.keys(options?.mcpServers ?? {})).toContain('turnstile')
  })

  /**
   * Found live, against a real Claude Code session: without this, `canUseTool` intercepts a
   * call to our OWN write tool before its handler ever runs, surfacing a redundant "Allow
   * mcp__turnstile__propose_edit?" prompt — the tool's own handler (`runToolWrite`, via
   * `writeFile`) already gates the write correctly; a second, generic gate in front of it is
   * not just redundant, it double-blocks a turn that already made its real gating decision.
   */
  test('canUseTool auto-allows the write tool itself, without a permission prompt', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const result = await canUseTool('mcp__turnstile__propose_edit', { path: 'a.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)

    expect(result).toEqual({ behavior: 'allow' })
    expect(events.some((e) => e.kind === 'permission')).toBe(false)
  })

  /**
   * Confirmed live against a real session: the plan text is on `input.plan` directly (the
   * SDK's own type defs only document a deprecated `allowedPrompts` field there), so it must be
   * read straight off `input` rather than reconstructed from anything else.
   */
  test('canUseTool: ExitPlanMode reads input.plan and maps requestPlanApproval to allow/deny', async () => {
    const fake = fakeQueryFn()
    const seen: { plan: string | null } = { plan: null }
    let decision: 'allow' | 'reject' = 'allow'
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async (plan) => {
        seen.plan = plan
        return decision === 'allow'
          ? { decision: 'allow' }
          : { decision: 'reject', reasoning: 'add tests' }
      },
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const allowResult = await canUseTool('ExitPlanMode', { plan: '# The Plan\n\nDo the thing.' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)
    expect(seen.plan).toBe('# The Plan\n\nDo the thing.')
    expect(allowResult).toEqual({ behavior: 'allow' })

    decision = 'reject'
    const denyResult = await canUseTool('ExitPlanMode', { plan: 'revised plan' }, {
      signal: new AbortController().signal,
      toolUseID: 't2',
      requestId: 'r2',
    } as never)
    expect(denyResult).toEqual({ behavior: 'deny', message: 'add tests' })
  })

  /**
   * Defense in depth: confirmed live that the model itself never attempts a write while
   * genuinely in plan mode, but `canUseTool`'s write-tool bypass must not rely on that
   * restraint holding — it has to actually deny the call itself while `planMode` is `'plan'`.
   */
  test('canUseTool: the write tool is denied while in plan mode, and allowed again once out of it', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1', { permissionMode: 'plan' }))
    await started
    await Bun.sleep(2)

    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')

    const deniedResult = await canUseTool('mcp__turnstile__propose_edit', { path: 'a.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'r1',
    } as never)
    expect(deniedResult).toEqual({
      behavior: 'deny',
      message: 'Still in plan mode — call ExitPlanMode before editing files.',
    })

    fake.push(statusMessage({ permissionMode: 'default' }))
    await Bun.sleep(2)

    const allowedResult = await canUseTool('mcp__turnstile__propose_edit', { path: 'a.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 't2',
      requestId: 'r2',
    } as never)
    expect(allowedResult).toEqual({ behavior: 'allow' })
  })

  /**
   * The hole this closed: plan mode checked the write tool and nothing else, so the agent could
   * not call `propose_edit` and could still write anywhere with `cat >`. Found in the wild — an
   * agent reported working around the refused write tool "via shell instead".
   */
  test('canUseTool: a Bash write is put to the human in plan mode, and reading still is not', async () => {
    const fake = fakeQueryFn()
    const prompts: { title: string; reason: string | null }[] = []
    const { approver, asked } = fakeApprover()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => {
        if (event.kind !== 'permission') return
        prompts.push({ title: event.title, reason: event.reason })
        // Answer it, so the call resolves rather than hanging the test.
        queueMicrotask(() => client.answerPermission(event.id, 'deny'))
      },
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      autoApprover: approver,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1', { permissionMode: 'plan' }))
    await started
    await Bun.sleep(2)

    const canUseTool = fake.calls[0]?.options.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool was not wired into Options')
    const call = (input: Record<string, unknown>, id: string) =>
      canUseTool('Bash', input, {
        signal: new AbortController().signal,
        toolUseID: id,
        requestId: id,
      } as never)

    // Exploring is what plan mode is for: still silent.
    expect(await call({ command: 'git log --oneline -5' }, 't1')).toEqual({ behavior: 'allow' })
    expect(prompts).toHaveLength(0)

    // Writing is not. It reaches the human instead of going through unseen.
    const written = await call({ command: 'cat > src/thing.ts' }, 't2')
    expect(written).toMatchObject({ behavior: 'deny' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.title).toBe('Let the agent do this while planning?')
    expect(prompts[0]?.reason).toContain('Plan mode is on')
    // Plan mode settled that one; auto-mode was only asked about the read.
    expect(asked.map((call) => call.input.command)).toEqual(['git log --oneline -5'])

    // Out of plan mode the same command is auto-mode's to decide again.
    fake.push(statusMessage({ permissionMode: 'default' }))
    await Bun.sleep(2)
    expect(await call({ command: 'cat > src/thing.ts' }, 't3')).toEqual({ behavior: 'allow' })
    expect(prompts).toHaveLength(1)
  })

  test('system/init and system/status permissionMode changes emit plan-mode-update events', async () => {
    const fake = fakeQueryFn()
    const events: { kind: string; mode?: string }[] = []
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event as never),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1', { permissionMode: 'plan' }))
    await started
    await Bun.sleep(2)

    expect(events).toContainEqual({ kind: 'plan-mode-update', mode: 'plan' })

    fake.push(statusMessage({ permissionMode: 'default' }))
    await Bun.sleep(2)

    expect(events).toContainEqual({ kind: 'plan-mode-update', mode: 'default' })
  })

  test('setPermissionMode(mode) calls through to the underlying Query', async () => {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: () => {},
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
    })

    const started = client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await started

    await client.setPermissionMode('plan')
    expect(fake.setPermissionModeCalls).toEqual(['plan'])
  })
})

describe('buildWriteTool', () => {
  test('allow: formats the applied content as the tool result text', async () => {
    const calls: { path: string; oldText: string | null; newText: string }[] = []
    const definition = buildWriteTool(async (input) => {
      calls.push(input)
      return { decision: 'allow', fileContent: 'new file contents\n' }
    }, '/repo')

    const result = await definition.handler(
      { path: 'src/a.ts', old_text: undefined, new_text: 'new file contents\n' },
      undefined,
    )

    expect(calls).toEqual([{ path: 'src/a.ts', oldText: null, newText: 'new file contents\n' }])
    expect(result.content).toEqual([
      { type: 'text', text: 'Applied. src/a.ts now reads:\n\nnew file contents\n' },
    ])
  })

  test('reject: the reasoning is returned as ordinary text, not isError', async () => {
    const definition = buildWriteTool(
      async () => ({ decision: 'reject', reasoning: 'no' }),
      '/repo',
    )

    const result = await definition.handler(
      { path: 'src/a.ts', old_text: 'x', new_text: 'y' },
      undefined,
    )

    expect(result.content).toEqual([{ type: 'text', text: 'no' }])
    expect(result.isError).toBeFalsy()
  })

  test('normalizes an absolute path under cwd to repo-relative before calling writeFile', async () => {
    const calls: { path: string; oldText: string | null; newText: string }[] = []
    const definition = buildWriteTool(async (input) => {
      calls.push(input)
      return { decision: 'allow', fileContent: '' }
    }, '/repo')

    await definition.handler(
      { path: '/repo/src/a.ts', old_text: undefined, new_text: '' },
      undefined,
    )

    expect(calls).toEqual([{ path: 'src/a.ts', oldText: null, newText: '' }])
  })
})

describe('agentEventsFromSessionMessages', () => {
  test('a plain-string user message becomes a user event', () => {
    expect(agentEventsFromSessionMessages([historyUserText('u-1', 'hello')])).toEqual([
      { kind: 'user', text: 'hello' },
    ])
  })

  test('an assistant text block becomes an assistant event', () => {
    expect(agentEventsFromSessionMessages([historyAssistantText('u-1', 'hi there')])).toEqual([
      { kind: 'assistant', text: 'hi there' },
    ])
  })

  test('a non-empty thinking block becomes a thought event; an empty one is skipped', () => {
    expect(agentEventsFromSessionMessages([historyThinking('u-1', 'hmm')])).toEqual([
      { kind: 'thought', text: 'hmm' },
    ])
    expect(agentEventsFromSessionMessages([historyThinking('u-1', '')])).toEqual([])
  })

  test('a tool_use block followed by its tool_result becomes pending then a terminal status', () => {
    const events = agentEventsFromSessionMessages([
      historyToolUse('u-1', 'toolu-1', 'Bash', { command: 'ls' }),
      historyToolResult('u-2', 'toolu-1'),
    ])
    expect(events).toEqual([
      { kind: 'tool', id: 'toolu-1', title: 'ls', toolKind: 'execute', status: 'pending' },
      { kind: 'tool', id: 'toolu-1', title: 'ls', toolKind: 'execute', status: 'completed' },
    ])
  })

  test('a failed tool_result carries status failed and the remembered title/toolKind', () => {
    const events = agentEventsFromSessionMessages([
      historyToolUse('u-1', 'toolu-1', 'Read', { file_path: 'src/a.ts' }),
      historyToolResult('u-2', 'toolu-1', true),
    ])
    expect(events[1]).toEqual({
      kind: 'tool',
      id: 'toolu-1',
      title: 'src/a.ts',
      toolKind: 'read',
      status: 'failed',
    })
  })

  test('a tool_result for an unmatched id falls back to an empty title and toolKind other', () => {
    const events = agentEventsFromSessionMessages([historyToolResult('u-1', 'toolu-orphan')])
    expect(events).toEqual([
      { kind: 'tool', id: 'toolu-orphan', title: '', toolKind: 'other', status: 'completed' },
    ])
  })

  test('a full turn replays in order: user, assistant text, tool_use, tool_result', () => {
    const events = agentEventsFromSessionMessages([
      historyUserText('u-1', 'fix the widget bug'),
      historyAssistantText('u-2', 'On it.'),
      historyToolUse('u-3', 'toolu-1', 'Bash', { command: 'ls' }),
      historyToolResult('u-4', 'toolu-1'),
    ])
    expect(events.map((event) => event.kind)).toEqual(['user', 'assistant', 'tool', 'tool'])
  })
})

/**
 * The subprocess can die under a live connection — killed by the OS (macOS refusing a binary
 * whose code signature it no longer trusts), crashed, out of memory. Nothing will ever answer a
 * prompt sent into a dead process, so a turn waiting on one must end, and the next prompt must
 * start a new one.
 */
describe('when the Claude Code process dies', () => {
  const killed = () => new Error('Claude Code process terminated by signal SIGKILL')

  function connect(events: AgentEvent[] = []) {
    const fake = fakeQueryFn()
    const client = connectAgentSdk({
      cwd: '/repo',
      onEvent: (event) => events.push(event),
      writeFile: async () => ({ decision: 'allow', fileContent: '' }),
      requestPlanApproval: async () => ({ decision: 'allow' }),
      queryFn: fake.queryFn,
      getSessionMessagesFn: async () => [],
    })
    return { fake, client }
  }

  test('mid-turn, the prompt fails with the reason instead of waiting forever', async () => {
    const { fake, client } = connect()
    await client.start('sess-1')
    const turn = client.prompt('hey')
    await Bun.sleep(0)

    fake.kill(killed())
    await expect(turn).rejects.toThrow('terminated by signal SIGKILL')
  })

  test('the next prompt starts a new process, resuming the conversation', async () => {
    const { fake, client } = connect()
    await client.start('sess-1')
    fake.push(initMessage('sess-1'))
    await Bun.sleep(0)
    fake.kill(killed())
    await Bun.sleep(0)

    const turn = client.prompt('hey')
    await Bun.sleep(0)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.options.resume).toBe('sess-1')

    fake.push(resultMessage())
    expect(await turn).toBe('end_turn')
  })

  test('dying before the conversation ever began starts it afresh, not as a resume', async () => {
    const { fake, client } = connect()
    await client.start('sess-1')
    fake.kill(killed())
    await Bun.sleep(0)

    void client.prompt('hey')
    await Bun.sleep(0)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.options.sessionId).toBe('sess-1')
    expect(fake.calls[1]?.options.resume).toBeUndefined()
  })

  test('dying between turns is reported, since no prompt is there to fail', async () => {
    const events: AgentEvent[] = []
    const { fake, client } = connect(events)
    await client.start('sess-1')
    fake.kill(killed())
    await Bun.sleep(0)

    expect(events).toContainEqual({
      kind: 'agent-error',
      message: 'Claude Code process terminated by signal SIGKILL',
    })
  })

  test('a process closed on purpose is not reported as dying', async () => {
    const events: AgentEvent[] = []
    const { fake, client } = connect(events)
    await client.start('sess-1')
    client.stop()
    fake.kill(killed())
    await Bun.sleep(0)

    expect(events.filter((event) => event.kind === 'agent-error')).toEqual([])
  })
})

/**
 * A resumed session's plans.
 *
 * A plan used to replay as a bare `ExitPlanMode` tool row with `input.plan` discarded, so
 * resuming a session that had planned looked like a session that never had.
 */
describe('agentEventsFromSessionMessages: plans', () => {
  const planCall = (id: string, plan: string) => ({
    type: 'assistant' as const,
    message: { content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } }] },
  })
  const planResult = (id: string, isError: boolean) => ({
    type: 'user' as const,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  })

  test('an approved plan comes back with its text', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', '# The Plan\n\n1. Do the thing.'),
      planResult('t1', false),
    ] as never)
    expect(events).toEqual([
      { kind: 'plan', text: '# The Plan\n\n1. Do the thing.', round: 1, outcome: 'approved' },
    ])
  })

  const said = (text: string) => ({
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }] },
  })

  test('a refusal is an error result, which is how the reasoning reached the agent', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'first try'),
      planResult('t1', true),
      said('Revising.'),
      // Replaced by a later plan, so the first one is settled history.
      planCall('t2', 'second try'),
      planResult('t2', false),
    ] as never)
    expect(events[0]).toMatchObject({ outcome: 'sent-back' })
  })

  /**
   * The last plan of a session is still on the table unless it was approved — whether nobody
   * ever answered it, or it was sent back and the agent never replaced it.
   */
  test('a plan the session died on comes back to be decided', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'the plan'),
      planResult('t1', true),
    ] as never)
    expect(events.at(-1)).toMatchObject({ kind: 'plan', outcome: 'standing' })
  })

  test('a plan sent back that the agent only talked about still stands', () => {
    // Measured against a real agent: a refusal does not reliably produce a revised plan. It
    // answered in prose and asked a question instead, and the plan was lost.
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'the plan'),
      planResult('t1', true),
      said('Good call — there are a few hardening strategies with real trade-offs.'),
    ] as never)
    expect(events.findLast((event) => event.kind === 'plan')).toMatchObject({
      outcome: 'standing',
    })
  })

  test('an approved plan is finished with, whatever follows it', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'the plan'),
      planResult('t1', false),
      said('Starting work.'),
    ] as never)
    expect(events.findLast((event) => event.kind === 'plan')).toMatchObject({
      outcome: 'approved',
    })
  })

  test('only the last plan stands — the ones it replaced are history', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'first try'),
      planResult('t1', true),
      planCall('t2', 'second try'),
      planResult('t2', true),
    ] as never)
    expect(events.map((event) => event.kind === 'plan' && event.outcome)).toEqual([
      'sent-back',
      'standing',
    ])
  })

  test('each plan is its own round, so a revision reads as one', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'first try'),
      planResult('t1', true),
      planCall('t2', 'second try'),
      planResult('t2', false),
    ] as never)
    expect(events.map((event) => event.kind === 'plan' && event.round)).toEqual([1, 2])
  })

  test('no tool row is emitted for it — the plan entry stands in for the call', () => {
    const events = agentEventsFromSessionMessages([
      planCall('t1', 'a plan'),
      planResult('t1', false),
    ] as never)
    expect(events.some((event) => event.kind === 'tool')).toBe(false)
  })

  test('a plan that was never answered leaves nothing, because nothing was decided', () => {
    const events = agentEventsFromSessionMessages([planCall('t1', 'unanswered')] as never)
    expect(events).toEqual([])
  })

  test('ordinary tool calls around it are untouched', () => {
    const events = agentEventsFromSessionMessages([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1' }] } },
      planCall('t1', 'a plan'),
      planResult('t1', false),
    ] as never)
    expect(events.filter((event) => event.kind === 'tool')).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'plan')).toHaveLength(1)
  })
})

/**
 * The plan tool.
 *
 * `Edit`/`Write` are disallowed and `propose_edit` is scoped to the repository, so the one file
 * the harness asks the agent to write — its plan, outside the project — had no sanctioned route
 * and was being written with a shell redirect. This is that route. Its safety is that the
 * destination is built rather than accepted, so these tests are mostly about what it refuses.
 */
describe('buildPlanTool', () => {
  const plansDir = join(tmpdir(), `turnstile-plans-${Math.random().toString(36).slice(2)}`)
  const run = (input: { path: string; content: string }) =>
    buildPlanTool(plansDir).handler(input, {} as never)

  test('writes the plan where the harness keeps it', async () => {
    const result = await run({ path: 'my-plan.md', content: '# The Plan' })
    expect(result.isError).toBeUndefined()
    expect(await Bun.file(join(plansDir, 'my-plan.md')).text()).toBe('# The Plan')
  })

  test('takes the filename out of a full path, since that is all it uses', async () => {
    await run({ path: join(plansDir, 'from-a-path.md'), content: 'x' })
    expect(await Bun.file(join(plansDir, 'from-a-path.md')).exists()).toBe(true)
  })

  test('cannot be pointed out of its directory', async () => {
    // The destination is built from a basename, so there is nothing left to traverse with.
    const attempt = await run({ path: '../../../tmp/turnstile-escaped.md', content: 'nope' })
    expect(attempt.isError).toBeUndefined()
    expect(await Bun.file(join(plansDir, 'turnstile-escaped.md')).exists()).toBe(true)
    expect(await Bun.file(join(tmpdir(), 'turnstile-escaped.md')).exists()).toBe(false)
  })

  test('refuses a name that is not a plain markdown file', async () => {
    for (const path of ['plan.sh', '..', 'plan$(whoami).md', '']) {
      const result = await run({ path, content: 'x' })
      expect(result.isError).toBe(true)
    }
  })

  test('reports a failed write rather than throwing into the turn', async () => {
    // A directory where the file should be: the write fails, and the agent is told so.
    const blocked = join(plansDir, 'taken.md')
    await mkdir(blocked, { recursive: true })
    const result = await run({ path: 'taken.md', content: 'x' })
    expect(result.isError).toBe(true)
    const said = result.content[0]
    expect(said?.type === 'text' && said.text).toContain('Could not write')
  })
})
