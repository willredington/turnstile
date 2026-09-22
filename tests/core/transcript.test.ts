import { describe, expect, test } from 'bun:test'
import type { ToolGroupEntry } from '../../src/core/transcript.ts'
import {
  appendEvent,
  appendNotice,
  appendUser,
  BRIEF_TITLE_CHARS,
  briefTitle,
  groupForReading,
  nowDoing,
  toolGroupIsRunning,
  toolGroupSpan,
} from '../../src/core/transcript.ts'
import type { AgentEvent, TranscriptEntry } from '../../src/core/types.ts'

/**
 * The agent emits text a few tokens at a time and re-announces a tool call on every status
 * change. Rendered literally that is hundreds of fragments and a dozen duplicate lines per
 * turn — the terminal-scrollback experience this app exists to improve on, faithfully
 * reproduced in a browser. These rules are what stop that.
 */

const AT = '2024-01-01T00:00:00.000Z'
const AT2 = '2024-01-01T00:00:05.000Z'

const text = (kind: 'assistant' | 'thought', value: string): AgentEvent =>
  ({ kind, text: value }) as AgentEvent

const tool = (
  id: string,
  overrides: Partial<{ title: string; toolKind: string; status: string }> = {},
): AgentEvent => ({
  kind: 'tool',
  id,
  title: overrides.title ?? 'Edit orders.ts',
  toolKind: overrides.toolKind ?? 'edit',
  status: overrides.status ?? 'pending',
})

const subagent = (
  taskId: string,
  overrides: Partial<{
    toolUseId: string | null
    status: string | null
    description: string | null
    subagentType: string | null
    lastToolName: string | null
    toolUses: number | null
    summary: string | null
  }> = {},
): AgentEvent =>
  ({
    kind: 'subagent',
    taskId,
    toolUseId: overrides.toolUseId ?? null,
    status: 'status' in overrides ? overrides.status : 'running',
    description: overrides.description ?? null,
    subagentType: overrides.subagentType ?? null,
    lastToolName: overrides.lastToolName ?? null,
    toolUses: overrides.toolUses ?? null,
    summary: overrides.summary ?? null,
  }) as AgentEvent

const build = (events: AgentEvent[]): TranscriptEntry[] =>
  events.reduce((acc, event) => appendEvent(acc, event, AT), [] as TranscriptEntry[])

describe('merging streamed text', () => {
  test('joins consecutive assistant chunks into one entry', () => {
    expect(build([text('assistant', 'I changed '), text('assistant', 'the reducer.')])).toEqual([
      { kind: 'assistant', text: 'I changed the reducer.', at: AT },
    ])
  })

  test('joins consecutive thinking the same way', () => {
    expect(build([text('thought', 'hmm'), text('thought', '...')])).toEqual([
      { kind: 'thought', text: 'hmm...', at: AT },
    ])
  })

  /** Thinking and speech are different things and must not run together. */
  test('does not merge thinking into speech', () => {
    expect(build([text('thought', 'hmm'), text('assistant', 'Done.')])).toEqual([
      { kind: 'thought', text: 'hmm', at: AT },
      { kind: 'assistant', text: 'Done.', at: AT },
    ])
  })

  test('starts a new entry when something interrupts the run', () => {
    const entries = build([text('assistant', 'one'), tool('tc-1'), text('assistant', 'two')])
    expect(entries.map((e) => e.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })

  test('keeps a user turn separate from what follows it', () => {
    const entries = appendEvent(appendUser([], 'do the thing', AT), text('assistant', 'ok'), AT)
    expect(entries).toEqual([
      { kind: 'user', text: 'do the thing', at: AT },
      { kind: 'assistant', text: 'ok', at: AT },
    ])
  })

  test('a user AgentEvent appends the same way appendUser does', () => {
    const entries = build([{ kind: 'user', text: 'do the thing' }])
    expect(entries).toEqual([{ kind: 'user', text: 'do the thing', at: AT }])
  })

  test('consecutive user events never merge into one line', () => {
    const entries = build([
      { kind: 'user', text: 'first' },
      { kind: 'user', text: 'second' },
    ])
    expect(entries).toEqual([
      { kind: 'user', text: 'first', at: AT },
      { kind: 'user', text: 'second', at: AT },
    ])
  })
})

describe('tool calls', () => {
  test('updates in place rather than repeating the line', () => {
    const entries = build([tool('tc-1'), tool('tc-1', { status: 'completed' })])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'completed' })
  })

  test('keeps separate calls separate', () => {
    expect(build([tool('tc-1'), tool('tc-2')])).toHaveLength(2)
  })

  /** A status-only update must not blank the line the reader is already looking at. */
  test('a later update with no title keeps the one it had', () => {
    const entries = build([tool('tc-1', { title: 'Edit orders.ts' }), tool('tc-1', { title: '' })])
    expect(entries[0]).toMatchObject({ title: 'Edit orders.ts' })
  })

  test('a later update with no kind keeps the one it had', () => {
    const entries = build([
      tool('tc-1', { toolKind: 'edit' }),
      tool('tc-1', { toolKind: 'other', status: 'completed' }),
    ])
    expect(entries[0]).toMatchObject({ toolKind: 'edit', status: 'completed' })
  })

  test('holds its position when it updates, so lines do not jump around', () => {
    const entries = build([tool('tc-1'), tool('tc-2'), tool('tc-1', { status: 'completed' })])
    expect(entries.map((e) => (e.kind === 'tool' ? e.id : ''))).toEqual(['tc-1', 'tc-2'])
  })
})

/**
 * A subagent launch is its own live entry, separate from the ordinary `Agent` tool row,
 * keyed by `taskId` rather than a tool_use id since `task_started` may arrive without one.
 * Updates merge in place the same way a tool call's do — a later event carrying `null` for a
 * field must not blank out a value an earlier one already set, since `task_progress` and
 * `task_updated` are partial by nature.
 */
describe('subagent activity', () => {
  test('creates an entry on the first sighting', () => {
    const entries = build([
      subagent('task-1', { description: 'Investigate widget bug', subagentType: 'general' }),
    ])
    expect(entries).toEqual([
      {
        kind: 'subagent',
        taskId: 'task-1',
        toolUseId: null,
        status: 'running',
        description: 'Investigate widget bug',
        subagentType: 'general',
        lastToolName: null,
        toolUses: null,
        summary: null,
        at: AT,
        endedAt: null,
      },
    ])
  })

  test('a later update merges into the same entry rather than adding another', () => {
    const entries = build([
      subagent('task-1', { description: 'Investigate widget bug' }),
      subagent('task-1', { lastToolName: 'Bash', toolUses: 3 }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ lastToolName: 'Bash', toolUses: 3 })
  })

  test('a later update with a null field keeps the value already recorded', () => {
    const entries = build([
      subagent('task-1', { description: 'Investigate widget bug', subagentType: 'general' }),
      subagent('task-1', { lastToolName: 'Bash', toolUses: 1 }),
    ])
    expect(entries[0]).toMatchObject({
      description: 'Investigate widget bug',
      subagentType: 'general',
    })
  })

  test('a later update with no status keeps the status already recorded', () => {
    const entries = build([
      subagent('task-1', { status: 'running' }),
      subagent('task-1', { status: null, description: 'renamed task' }),
    ])
    expect(entries[0]).toMatchObject({ status: 'running', description: 'renamed task' })
  })

  test('keeps separate tasks separate', () => {
    expect(build([subagent('task-1'), subagent('task-2')])).toHaveLength(2)
  })

  test('holds its position when it updates', () => {
    const entries = build([
      subagent('task-1'),
      subagent('task-2'),
      subagent('task-1', { toolUses: 2 }),
    ])
    expect(entries.map((e) => (e.kind === 'subagent' ? e.taskId : ''))).toEqual([
      'task-1',
      'task-2',
    ])
  })

  test('endedAt is set the moment a task first reaches a terminal status', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, subagent('task-1'), AT)
    entries = appendEvent(
      entries,
      subagent('task-1', { status: 'completed', summary: 'Fixed it' }),
      AT2,
    )
    expect(entries[0]).toMatchObject({
      at: AT,
      endedAt: AT2,
      status: 'completed',
      summary: 'Fixed it',
    })
  })

  test('endedAt never moves once a task has finished', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, subagent('task-1'), AT)
    entries = appendEvent(entries, subagent('task-1', { status: 'completed' }), AT2)
    entries = appendEvent(
      entries,
      subagent('task-1', { status: 'completed', summary: 'late update' }),
      '2024-01-01T00:00:10.000Z',
    )
    expect(entries[0]).toMatchObject({ at: AT, endedAt: AT2 })
  })
})

/**
 * `at` marks when an entry started and must survive every update that follows it; `endedAt`
 * marks the one moment a tool call first finishes and must never move after that.
 */
describe('timestamps', () => {
  test('a merged assistant run keeps the at of its first chunk', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, text('assistant', 'I changed '), AT)
    entries = appendEvent(entries, text('assistant', 'the reducer.'), AT2)
    expect(entries).toEqual([{ kind: 'assistant', text: 'I changed the reducer.', at: AT }])
  })

  test('a merged thought run keeps the at of its first chunk', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, text('thought', 'hmm'), AT)
    entries = appendEvent(entries, text('thought', '...'), AT2)
    expect(entries).toEqual([{ kind: 'thought', text: 'hmm...', at: AT }])
  })

  test('a tool keeps its first at across a status-only update', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, tool('tc-1'), AT)
    entries = appendEvent(entries, tool('tc-1', { status: 'in_progress' }), AT2)
    expect(entries[0]).toMatchObject({ at: AT, endedAt: null })
  })

  test('endedAt is set the moment a tool first reaches a terminal status', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, tool('tc-1'), AT)
    entries = appendEvent(entries, tool('tc-1', { status: 'completed' }), AT2)
    expect(entries[0]).toMatchObject({ at: AT, endedAt: AT2 })
  })

  test('endedAt never moves once a tool has finished', () => {
    let entries: TranscriptEntry[] = []
    entries = appendEvent(entries, tool('tc-1'), AT)
    entries = appendEvent(entries, tool('tc-1', { status: 'completed' }), AT2)
    entries = appendEvent(
      entries,
      tool('tc-1', { status: 'completed' }),
      '2024-01-01T00:00:10.000Z',
    )
    expect(entries[0]).toMatchObject({ at: AT, endedAt: AT2 })
  })

  test('a tool already terminal on first sight has equal at and endedAt', () => {
    const entries = appendEvent([], tool('tc-1', { status: 'completed' }), AT)
    expect(entries[0]).toMatchObject({ at: AT, endedAt: AT })
  })
})

describe('events that are not transcript', () => {
  test('an error becomes a visible notice, and reads as one', () => {
    expect(build([{ kind: 'agent-error', message: 'agent died' }])).toEqual([
      { kind: 'notice', text: 'agent died', tone: 'bad', at: AT },
    ])
  })

  /** Permission drives its own UI; it is answered, not read back later. */
  test('permission events leave the transcript alone', () => {
    const events: AgentEvent[] = [
      {
        kind: 'permission',
        id: 'p1',
        title: 'Allow?',
        subject: null,
        description: null,
        reason: null,
        options: [],
      },
      { kind: 'permission-resolved', id: 'p1' },
    ]
    expect(build(events)).toEqual([])
  })
})

/**
 * Notices are the punctuation of a session: they are what separates one review cycle from
 * the next in a column of otherwise uniform text, so their weight has to survive into the
 * entry rather than being decided by whoever renders it.
 */
describe('notice tone', () => {
  test('is informational unless stated', () => {
    expect(appendNotice([], 'checkpoint moved', AT)[0]).toMatchObject({ tone: 'info' })
  })

  test('carries the weight it was given', () => {
    expect(appendNotice([], 'approved', AT, 'good')[0]).toMatchObject({
      kind: 'notice',
      text: 'approved',
      tone: 'good',
    })
  })
})

/**
 * What to say during the silence.
 *
 * Most of a turn is nothing arriving: a tool reports back, then twenty seconds pass while the
 * model decides what to do next. A column that simply stops is indistinguishable from one
 * that has finished, so something has to stand in for the gap.
 */
describe('what the agent is doing', () => {
  const tool = (id: string, title: string, status: string): TranscriptEntry => ({
    kind: 'tool',
    id,
    title,
    toolKind: 'read',
    status,
    at: AT,
    endedAt: status === 'completed' || status === 'failed' ? AT : null,
  })

  test('thinking, when nothing is outstanding', () => {
    expect(nowDoing([{ kind: 'assistant', text: 'I will start by', at: AT }])).toEqual({
      kind: 'thinking',
    })
  })

  test('thinking, on an empty transcript', () => {
    expect(nowDoing([])).toEqual({ kind: 'thinking' })
  })

  /** The more specific answer wins: naming the file beats naming the activity. */
  test('the tool that has not reported back', () => {
    const entries = [tool('1', 'Read src/a.ts', 'completed'), tool('2', 'Read src/b.ts', 'pending')]
    expect(nowDoing(entries)).toEqual({ kind: 'tool', title: 'Read src/b.ts', toolKind: 'read' })
  })

  test('thinking again once every tool has reported', () => {
    const entries = [tool('1', 'Read src/a.ts', 'completed'), tool('2', 'Read src/b.ts', 'failed')]
    expect(nowDoing(entries)).toEqual({ kind: 'thinking' })
  })

  /**
   * The agent picks these words. A status we have not seen before has to read as still
   * running — assuming it finished would silently drop the indicator mid-turn.
   */
  test('treats an unfamiliar status as still running', () => {
    expect(nowDoing([tool('1', 'Read src/a.ts', 'in_progress')])).toEqual({
      kind: 'tool',
      title: 'Read src/a.ts',
      toolKind: 'read',
    })
  })

  /** Text arriving after a tool started does not mean the tool came back. */
  test('finds a running tool that is no longer the last entry', () => {
    const entries: TranscriptEntry[] = [
      tool('1', 'Edit src/a.ts', 'pending'),
      { kind: 'assistant', text: 'meanwhile', at: AT },
    ]
    expect(nowDoing(entries)).toEqual({ kind: 'tool', title: 'Edit src/a.ts', toolKind: 'read' })
  })
})

/**
 * `groupForReading` is what lets the pane show a run of tool calls as one card instead of
 * one line each.
 */
describe('groupForReading', () => {
  const toolEntry = (
    id: string,
    status: string,
    overrides: Partial<{ at: string; endedAt: string | null }> = {},
  ): TranscriptEntry => ({
    kind: 'tool',
    id,
    title: `Tool ${id}`,
    toolKind: 'read',
    status,
    at: overrides.at ?? AT,
    endedAt: overrides.endedAt ?? (status === 'completed' || status === 'failed' ? AT : null),
  })

  function expectGroup(entry: TranscriptEntry | ToolGroupEntry | undefined): ToolGroupEntry {
    if (entry === undefined || entry.kind !== 'tool-group') {
      throw new Error('expected a tool group')
    }
    return entry
  }

  test('a lone tool call is not wrapped into a group', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', text: 'before', at: AT },
      toolEntry('1', 'completed'),
      { kind: 'assistant', text: 'after', at: AT },
    ]
    expect(groupForReading(entries).map((r) => r.entry.kind)).toEqual([
      'assistant',
      'tool',
      'assistant',
    ])
  })

  test('folds a run of consecutive tool calls into one group', () => {
    const entries: TranscriptEntry[] = [
      toolEntry('1', 'completed'),
      toolEntry('2', 'completed'),
      toolEntry('3', 'completed'),
    ]
    const result = groupForReading(entries)
    expect(result).toHaveLength(1)
    const group = expectGroup(result[0]?.entry)
    expect(group.tools.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  test('a run broken by prose forms two separate groups', () => {
    const entries: TranscriptEntry[] = [
      toolEntry('1', 'completed'),
      toolEntry('2', 'completed'),
      { kind: 'assistant', text: 'checking in', at: AT },
      toolEntry('3', 'completed'),
      toolEntry('4', 'completed'),
    ]
    expect(groupForReading(entries).map((r) => r.entry.kind)).toEqual([
      'tool-group',
      'assistant',
      'tool-group',
    ])
  })

  test('a group with a failed member is still one group, and reads as not running', () => {
    const entries: TranscriptEntry[] = [toolEntry('1', 'completed'), toolEntry('2', 'failed')]
    const group = expectGroup(groupForReading(entries)[0]?.entry)
    expect(group.tools).toHaveLength(2)
    expect(toolGroupIsRunning(group)).toBe(false)
  })

  test('a group with a still-running member reports itself as running', () => {
    const entries: TranscriptEntry[] = [toolEntry('1', 'completed'), toolEntry('2', 'pending')]
    const group = expectGroup(groupForReading(entries)[0]?.entry)
    expect(toolGroupIsRunning(group)).toBe(true)
  })

  test('a group spans its first call to its last call ending', () => {
    const entries: TranscriptEntry[] = [
      toolEntry('1', 'completed', { at: AT, endedAt: AT }),
      toolEntry('2', 'completed', { at: AT2, endedAt: AT2 }),
    ]
    const group = expectGroup(groupForReading(entries)[0]?.entry)
    expect(toolGroupSpan(group)).toEqual({ at: AT, endedAt: AT2 })
  })
})

describe('briefTitle', () => {
  test('leaves a short one-line title alone', () => {
    expect(briefTitle('git status')).toBe('git status')
  })

  test('keeps only the first line of a multi-line command', () => {
    expect(briefTitle(`cat > x.py <<'EOF'\nimport sys\nEOF`)).toBe(`cat > x.py <<'EOF'…`)
  })

  test('cuts a long line to the limit with an ellipsis', () => {
    const brief = briefTitle(`echo ${'a'.repeat(200)}`)
    expect(brief.endsWith('…')).toBe(true)
    expect(brief.length).toBe(BRIEF_TITLE_CHARS + 1)
  })

  test('collapses runs of whitespace', () => {
    expect(briefTitle('  ls    -la\t src  ')).toBe('ls -la src')
  })
})
