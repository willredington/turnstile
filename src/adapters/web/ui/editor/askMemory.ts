import type { AskAnchor, AskTurn } from '../../../../core/ask.ts'

/**
 * The questions asked about each tab, for as long as the page is open.
 *
 * Module scope for the same reason `scrollMemory.ts` is: both file panes are keyed per tab, so
 * switching away unmounts everything holding the thread. Keeping it here means a question you
 * asked, walked away from and came back to is still there, without threading a store through
 * `App.tsx` for something the server never sees.
 *
 * Deliberately not persisted, and not in `SessionState`. An answer is not a note: notes are the
 * thing that survives, reaches the agent and becomes work, and blurring the two would make the
 * board's record of what was asked for mean less. This is a conversation you had while reading,
 * and it is gone when you close the page.
 *
 * Keyed by the same `tabKey` that `scrollMemory` uses — anything that remembers something about
 * a tab has to agree with what counts as the same tab.
 */

export type AskThread = {
  id: string
  /** The lines it is about, or null for the whole file. */
  anchor: AskAnchor
  /** Those lines verbatim, so the card can show what was asked about. */
  quote: string
  /** Settled exchanges, oldest first — and what a follow-up is given as context. */
  turns: AskTurn[]
  /**
   * The question with nothing back yet. Null when nothing is outstanding.
   *
   * Kept on a failure too, rather than discarded: the reader should see which question could
   * not be answered, and be able to send it again without retyping it.
   */
  pending: string | null
  /** Why `pending` could not be answered. Null while it is still in flight. */
  error: string | null
}

const EMPTY: readonly AskThread[] = []

const threads = new Map<string, readonly AskThread[]>()
const listeners = new Set<() => void>()
let nextId = 1

function notify(): void {
  for (const listener of listeners) listener()
}

/** Replace one thread in one tab, leaving every other thread and tab untouched. */
function update(key: string, id: string, change: (thread: AskThread) => AskThread): void {
  const current = threads.get(key)
  if (current === undefined) return
  threads.set(
    key,
    current.map((thread) => (thread.id === id ? change(thread) : thread)),
  )
  notify()
}

/**
 * The threads on a tab. Stable by identity while nothing changes, so it can be a
 * `useSyncExternalStore` snapshot without looping.
 */
export function recallThreads(key: string): readonly AskThread[] {
  return threads.get(key) ?? EMPTY
}

export function subscribeThreads(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Start a thread. Returns its id, which is also its widget's.
 *
 * `question` is optional because the two ways in differ: a drag over the gutter has already
 * been typed into by the time it becomes a question, while "Ask about this file" is a button
 * with nothing typed yet — it opens an empty card to type into rather than inventing a
 * question nobody asked.
 */
export function startThread(
  key: string,
  input: { anchor: AskAnchor; quote: string; question?: string },
): string {
  const id = `t${nextId++}`
  threads.set(key, [
    ...recallThreads(key),
    {
      id,
      anchor: input.anchor,
      quote: input.quote,
      turns: [],
      pending: input.question ?? null,
      error: null,
    },
  ])
  notify()
  return id
}

/** Ask a follow-up, or send a failed question again. */
export function continueThread(key: string, id: string, question: string): void {
  update(key, id, (thread) => ({ ...thread, pending: question, error: null }))
}

export function settleThread(key: string, id: string, answer: string): void {
  update(key, id, (thread) =>
    thread.pending === null
      ? thread
      : {
          ...thread,
          turns: [...thread.turns, { question: thread.pending, answer }],
          pending: null,
          error: null,
        },
  )
}

export function failThread(key: string, id: string, error: string): void {
  update(key, id, (thread) => ({ ...thread, error }))
}

export function closeThread(key: string, id: string): void {
  const current = threads.get(key)
  if (current === undefined) return
  threads.set(
    key,
    current.filter((thread) => thread.id !== id),
  )
  notify()
}

/** Test seam. Nothing in the app forgets a tab — the page closing is what clears this. */
export function forgetAllThreads(): void {
  threads.clear()
  notify()
}
