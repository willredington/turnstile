import { afterEach, describe, expect, test } from 'bun:test'
import { postForJson, postOrThrow } from '../../../../src/adapters/web/ui/http.ts'

/**
 * The save path's contract.
 *
 * `post` next to it is deliberately fire-and-forget, and a save wired to it by mistake is
 * invisible: the editor clears its unsaved-changes marker when the call resolves, so the
 * reader is told their work is on disk when the server refused it. That happened once; this
 * is what keeps it from happening quietly again.
 *
 * `postForJson` is held to the same bar for the same reason: an unanswerable question has to
 * become a message on the card, never a spinner that never stops.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function answering(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('postOrThrow', () => {
  test('resolves when the server took it', async () => {
    answering(200, { ok: true })
    expect(await postOrThrow('/file/save', { text: 'x' })).toBeUndefined()
  })

  test('throws the reason the server gave', async () => {
    answering(409, { error: 'EACCES: permission denied' })
    expect(postOrThrow('/file/save', { text: 'x' })).rejects.toThrow('EACCES: permission denied')
  })

  test('throws even when the server explained nothing', async () => {
    answering(500, {})
    expect(postOrThrow('/file/save', { text: 'x' })).rejects.toThrow('500')
  })

  test('throws when the body is not JSON at all', async () => {
    globalThis.fetch = (async () =>
      new Response('gateway timeout', { status: 504 })) as unknown as typeof fetch
    expect(postOrThrow('/file/save', { text: 'x' })).rejects.toThrow('504')
  })
})

describe('postForJson', () => {
  test('returns the answer the server sent', async () => {
    answering(200, { answer: 'Because of the tab rows.' })
    const body = await postForJson<{ answer: string }>('/ask', { question: 'why?' })
    expect(body.answer).toBe('Because of the tab rows.')
  })

  test('throws the reason the server gave, so a spinner can become a message', async () => {
    answering(409, { error: 'OPENROUTER_API_KEY is not set.' })
    expect(postForJson('/ask', { question: 'why?' })).rejects.toThrow('OPENROUTER_API_KEY')
  })

  test('throws when the body is not JSON at all', async () => {
    globalThis.fetch = (async () =>
      new Response('gateway timeout', { status: 504 })) as unknown as typeof fetch
    expect(postForJson('/ask', { question: 'why?' })).rejects.toThrow('504')
  })
})
