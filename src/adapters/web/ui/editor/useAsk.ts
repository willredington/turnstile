import { useCallback, useSyncExternalStore } from 'react'
import type { AskAnchor } from '../../../../core/ask.ts'
import { postForJson } from '../http.ts'
import {
  type AskThread,
  closeThread,
  continueThread,
  failThread,
  recallThreads,
  settleThread,
  startThread,
  subscribeThreads,
} from './askMemory.ts'

/**
 * Asking questions about the file on screen, for whichever document surface is showing it.
 *
 * The store is the source of truth and the server holds nothing, so a follow-up sends the whole
 * thread back with it. That is what lets `/ask` stay a plain request/response and never touch
 * the session — which in turn is what lets a question be answered while the agent is working.
 */
export type Ask = {
  threads: readonly AskThread[]
  /** Ask something new about a range, or about the whole file when `anchor` is null. */
  ask: (anchor: AskAnchor, quote: string, question: string) => void
  /** Open an empty thread to type into — the "Ask about this file" button's way in. */
  open: (anchor: AskAnchor, quote: string) => void
  /** Ask a follow-up on an existing thread, or send a failed question again. */
  follow: (id: string, question: string) => void
  close: (id: string) => void
}

export function useAsk(scrollKey: string, root: string | null, path: string): Ask {
  const threads = useSyncExternalStore(subscribeThreads, () => recallThreads(scrollKey))

  /**
   * Send whatever is pending on a thread and settle it.
   *
   * Reads the thread back out of the store rather than taking it as an argument: the question
   * and the turns before it are already there, and passing them separately is how the payload
   * and what is on screen drift apart.
   */
  const send = useCallback(
    (id: string, anchor: AskAnchor, question: string) => {
      const before = recallThreads(scrollKey).find((thread) => thread.id === id)
      void postForJson<{ answer: string }>('/ask', {
        ...(root === null ? {} : { root }),
        path,
        anchor,
        history: before?.turns ?? [],
        question,
      })
        .then((body) => settleThread(scrollKey, id, body.answer))
        .catch((error: unknown) =>
          failThread(scrollKey, id, error instanceof Error ? error.message : String(error)),
        )
    },
    [scrollKey, root, path],
  )

  const ask = useCallback(
    (anchor: AskAnchor, quote: string, question: string) => {
      const id = startThread(scrollKey, { anchor, quote, question })
      send(id, anchor, question)
    },
    [scrollKey, send],
  )

  /**
   * At most one empty thread per anchor: clicking the header button twice should put the cursor
   * back in the card that is already open, not stack another blank one under it.
   */
  const open = useCallback(
    (anchor: AskAnchor, quote: string) => {
      const blank = recallThreads(scrollKey).find(
        (thread) => thread.turns.length === 0 && thread.pending === null,
      )
      if (blank !== undefined) return
      startThread(scrollKey, { anchor, quote })
    },
    [scrollKey],
  )

  const follow = useCallback(
    (id: string, question: string) => {
      const thread = recallThreads(scrollKey).find((candidate) => candidate.id === id)
      if (thread === undefined) return
      continueThread(scrollKey, id, question)
      send(id, thread.anchor, question)
    },
    [scrollKey, send],
  )

  const close = useCallback((id: string) => closeThread(scrollKey, id), [scrollKey])

  return { threads, ask, open, follow, close }
}
