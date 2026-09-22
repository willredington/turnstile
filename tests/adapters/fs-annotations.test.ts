import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { annotationsPath, createFileAnnotationStore } from '../../src/adapters/fs/annotations.ts'
import type { Annotation } from '../../src/core/types.ts'

/**
 * Notes on lines, in `.turnstile/annotations.json`.
 *
 * Scoped to the session (conversation) that wrote them: a note is about that session's worktree,
 * so no other session ever sees, delivers, removes or rewrites it.
 */

let dir: string

const SESSION = 'sess-1'
const OTHER_SESSION = 'sess-2'

function note(overrides: Partial<Annotation> = {}): Annotation {
  const line = overrides.line ?? 14
  return {
    id: 'n1',
    sessionId: SESSION,
    root: '/repo/.turnstile/worktrees/sess-1',
    path: 'src/orders.ts',
    line,
    rangeStart: line,
    side: 'new',
    lineText: '  return total * 0.9',
    body: 'this should use the constant',
    at: '2026-09-01T12:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turnstile-annotations-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('recording notes', () => {
  test('a fresh store has none', async () => {
    expect(await createFileAnnotationStore(dir).bySession(SESSION)).toEqual([])
  })

  test('round-trips a note', async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note())

    expect(await store.bySession(SESSION)).toEqual([note()])
  })

  test('survives a new instance', async () => {
    await createFileAnnotationStore(dir).add(note())
    expect(await createFileAnnotationStore(dir).bySession(SESSION)).toEqual([note()])
  })

  /** A note saved before ranges existed reads as a note on its one line. */
  test('a stored note with no rangeStart reads as a single-line range', async () => {
    const { rangeStart: _rangeStart, ...old } = note({ line: 20 })
    await Bun.write(annotationsPath(dir), JSON.stringify({ annotations: [old] }))

    expect((await createFileAnnotationStore(dir).bySession(SESSION))[0]?.rangeStart).toBe(20)
  })
})

describe('session scoping', () => {
  test('a note written in one session is invisible in another', async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note())

    expect(await store.bySession(OTHER_SESSION)).toEqual([])
    expect(await store.bySession(SESSION)).toEqual([note()])
  })

  test('two sessions can each hold a note without colliding', async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note({ id: 'a', sessionId: SESSION, body: 'mine' }))
    await store.add(note({ id: 'b', sessionId: OTHER_SESSION, body: 'theirs' }))

    expect((await store.bySession(SESSION)).map((n) => n.body)).toEqual(['mine'])
    expect((await store.bySession(OTHER_SESSION)).map((n) => n.body)).toEqual(['theirs'])
  })
})

describe('removing and marking sent', () => {
  test("remove drops one of the session's own notes", async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note())
    await store.remove(SESSION, 'n1')

    expect(await store.bySession(SESSION)).toEqual([])
  })

  test("remove leaves another session's note alone, whatever id is passed", async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note({ sessionId: OTHER_SESSION }))
    await store.remove(SESSION, 'n1')

    expect(await store.bySession(OTHER_SESSION)).toHaveLength(1)
  })

  test('markSent only sets it once', async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note())
    await store.markSent(SESSION, ['n1'], '2026-09-01T13:00:00.000Z')
    await store.markSent(SESSION, ['n1'], '2026-09-01T14:00:00.000Z')

    expect((await store.bySession(SESSION))[0]?.sentAt).toBe('2026-09-01T13:00:00.000Z')
  })

  test("markSent leaves another session's note alone", async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note({ sessionId: OTHER_SESSION }))
    await store.markSent(SESSION, ['n1'], '2026-09-01T13:00:00.000Z')

    expect((await store.bySession(OTHER_SESSION))[0]?.sentAt).toBeNull()
  })

  test("markUnsent puts a note back, leaving another session's alone", async () => {
    const store = createFileAnnotationStore(dir)
    await store.add(note())
    await store.add(note({ sessionId: OTHER_SESSION }))
    await store.markSent(SESSION, ['n1'], '2026-09-01T13:00:00.000Z')
    await store.markSent(OTHER_SESSION, ['n1'], '2026-09-01T13:00:00.000Z')
    await store.markUnsent(SESSION, ['n1'])

    expect((await store.bySession(SESSION))[0]?.sentAt).toBeNull()
    expect((await store.bySession(OTHER_SESSION))[0]?.sentAt).toBe('2026-09-01T13:00:00.000Z')
  })
})

describe('a damaged or older store', () => {
  test('unparseable JSON hides no work', async () => {
    await Bun.write(annotationsPath(dir), '{ not json')
    expect(await createFileAnnotationStore(dir).bySession(SESSION)).toEqual([])
  })

  /** A note in an older shape (run-keyed and chunk-anchored, with no `root`) is never read —
   *  and never dropped or rewritten by a later write either. */
  test('an old entry with no root is never read, and survives writes untouched', async () => {
    const { root: _root, ...legacy } = note({ id: 'legacy' })
    const old = { ...legacy, runId: 'run-1', kind: 'note', chunkKey: 'chunk-a' }
    await Bun.write(annotationsPath(dir), JSON.stringify({ annotations: [old] }))

    const store = createFileAnnotationStore(dir)
    expect(await store.bySession(SESSION)).toEqual([])

    await store.add(note())
    await store.markSent(SESSION, ['n1', 'legacy'], '2026-09-01T13:00:00.000Z')
    await store.remove(SESSION, 'legacy')

    const onDisk = await Bun.file(annotationsPath(dir)).json()
    expect(onDisk.annotations[0]).toEqual(old)
    expect(await store.bySession(SESSION)).toHaveLength(1)
  })

  test('an old entry with no sessionId is never read', async () => {
    const { sessionId: _sessionId, ...legacy } = note({ id: 'legacy' })
    await Bun.write(annotationsPath(dir), JSON.stringify({ annotations: [legacy] }))

    expect(await createFileAnnotationStore(dir).bySession(SESSION)).toEqual([])
  })
})
