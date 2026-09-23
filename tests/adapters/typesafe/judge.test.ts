import { describe, expect, test } from 'bun:test'
import { createTypeSafeJudge } from '../../../src/adapters/typesafe/judge.ts'
import { callState } from '../../../src/core/autoMode.ts'

const state = callState('Bash', { command: 'git push' }, { cwd: '/repo', home: '/Users/me' })
const rules = [
  { id: 'push', text: 'Pushes to a remote' },
  { id: 'sudo', text: 'Runs as root' },
]

function respond(body: unknown, status = 200) {
  const requests: { url: string; body: unknown; headers: Headers }[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({
      url,
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, requests }
}

describe('createTypeSafeJudge', () => {
  test('asks one noul per rule, keyed by id, over the call state, in one request', async () => {
    const { fetch, requests } = respond({
      model: 'jev',
      answers: { push: { type: 'noul', noul: 0.9 }, sudo: { type: 'noul', noul: 0.02 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const judge = createTypeSafeJudge({ apiKey: 'k', model: 'jev-latest', timeoutMs: 1_000, fetch })

    const answers = await judge.judge(state, rules)

    expect(answers).toEqual(
      new Map([
        ['push', 0.9],
        ['sudo', 0.02],
      ]),
    )
    expect(requests).toHaveLength(1)
    const body = requests[0]?.body as {
      state: unknown
      model: string
      questions: Record<string, { type: string }>
    }
    expect(requests[0]?.url).toEndWith('/v1/systemone')
    expect(body.state).toEqual(state)
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['push', 'sudo'])
    expect(body.questions.push?.type).toBe('noul')
    expect(JSON.stringify(body.questions.push)).toContain('Pushes to a remote')
  })

  test('an answer that is missing or not a noul is left out, for the caller to refuse', async () => {
    const { fetch } = respond({
      model: 'jev',
      answers: { push: { type: 'choice', choice: 'x' } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const judge = createTypeSafeJudge({ apiKey: 'k', model: 'jev-latest', timeoutMs: 1_000, fetch })
    expect(await judge.judge(state, rules)).toEqual(new Map())
  })

  test('a refused request throws', async () => {
    const { fetch } = respond({ error: 'bad key' }, 401)
    const judge = createTypeSafeJudge({ apiKey: 'k', model: 'jev-latest', timeoutMs: 1_000, fetch })
    await expect(judge.judge(state, rules)).rejects.toThrow()
  })
})
