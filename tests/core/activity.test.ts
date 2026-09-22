import { describe, expect, test } from 'bun:test'
import { activityOf } from '../../src/core/activity.ts'
import type { SessionState, TranscriptEntry } from '../../src/core/types.ts'

const AT = '2026-01-01T00:00:00.000Z'

type Input = Parameters<typeof activityOf>[0]

const base = (overrides: Partial<Input> = {}): Input => ({
  status: 'idle',
  transcript: [],
  permissions: [],
  questions: [],
  planReview: null,
  queued: [],
  ...overrides,
})

const tool = (toolKind: string, title: string, status = 'pending'): TranscriptEntry => ({
  kind: 'tool',
  id: `${toolKind}-${title}`,
  title,
  toolKind,
  status,
  at: AT,
  endedAt: null,
})

/**
 * The header's one line about the agent. It has to agree with the transcript's newest line,
 * and it has to say something in every state — an empty pill reads as a broken screen.
 */
describe('the activity bar', () => {
  test('connecting, while the session starts', () => {
    expect(activityOf(base({ status: 'starting' }))).toEqual({
      tone: 'starting',
      verb: 'connecting to the agent',
      target: '',
    })
  })

  test('thinking, while working with no tool outstanding', () => {
    expect(activityOf(base({ status: 'working' }))).toEqual({
      tone: 'live',
      verb: 'thinking',
      target: '',
    })
  })

  test('names the running tool with a verb for its kind', () => {
    const cases: [string, string][] = [
      ['read', 'reading'],
      ['search', 'searching'],
      ['edit', 'editing'],
      ['execute', 'running'],
      ['fetch', 'fetching'],
      ['agent', 'subagent'],
      ['other', 'using'],
    ]
    for (const [kind, verb] of cases) {
      const activity = activityOf(base({ status: 'working', transcript: [tool(kind, 'x')] }))
      expect(activity).toEqual({ tone: 'live', verb, target: 'x' })
    }
  })

  test('back to thinking once the tool reports', () => {
    const transcript = [tool('edit', 'src/a.ts', 'completed')]
    expect(activityOf(base({ status: 'working', transcript })).verb).toBe('thinking')
  })

  /** Blocked on the reader outranks what the agent was doing when it asked. */
  test('waiting on you, for a permission prompt', () => {
    const activity = activityOf(
      base({
        status: 'working',
        transcript: [tool('execute', 'rm -rf x')],
        permissions: [
          {
            id: 'p',
            title: 'Allow rm -rf x?',
            subject: null,
            description: null,
            reason: null,
            options: [],
          },
        ],
      }),
    )
    expect(activity).toEqual({ tone: 'you', verb: 'waiting on you', target: 'Allow rm -rf x?' })
  })

  test('waiting on you, for a question', () => {
    const questions: SessionState['questions'] = [
      {
        id: 'q',
        questions: [
          { question: 'Which one?', header: 'Pick', options: [], multiSelect: false },
        ] as SessionState['questions'][number]['questions'],
      },
    ]
    const activity = activityOf(base({ status: 'working', questions }))
    expect(activity).toEqual({ tone: 'you', verb: 'waiting on you', target: 'Which one?' })
  })

  test('waiting on you, for a plan', () => {
    const activity = activityOf(
      base({ status: 'working', planReview: { plan: 'p', round: 1, notes: [], recovered: false } }),
    )
    expect(activity.tone).toBe('you')
  })

  test('idle, counting only what the reader queued', () => {
    expect(activityOf(base())).toEqual({ tone: 'idle', verb: 'idle', target: '' })
    const queued = [
      { id: '1', text: 'a', at: AT },
      { id: '2', text: 'b', at: AT },
      { id: '3', text: 'c', at: AT, origin: 'system' },
    ] as Input['queued']
    expect(activityOf(base({ queued })).target).toBe('2 queued, sends on the next turn')
  })
})
