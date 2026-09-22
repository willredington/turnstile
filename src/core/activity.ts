import { briefTitle, nowDoing } from './transcript.ts'
import type { SessionState } from './types.ts'

/**
 * The header's activity bar: one line saying what the agent is doing — a verb, then its target.
 *
 * Informational only. It says the same thing the transcript's newest line says, always in the
 * same place, so a reader looking at a file never has to open the conversation to tell a long
 * thought from a hung session.
 *
 * `tone` is how the bar is drawn: `live` spins, `you` glows (the turn is blocked on the reader),
 * `starting` spins quietly, `idle` is a flat dot.
 */
export type Activity = {
  tone: 'live' | 'you' | 'starting' | 'idle'
  verb: string
  /** What the verb acts on, or empty when there is nothing more to say. */
  target: string
}

/** The present-tense verb for a tool call, by the `toolKind` the agent adapter assigns. */
const VERBS: Record<string, string> = {
  read: 'reading',
  search: 'searching',
  edit: 'editing',
  execute: 'running',
  fetch: 'fetching',
  agent: 'subagent',
}

export function activityOf(
  state: Pick<
    SessionState,
    'status' | 'transcript' | 'permissions' | 'questions' | 'planReview' | 'queued'
  >,
): Activity {
  if (state.status === 'starting') {
    return { tone: 'starting', verb: 'connecting to the agent', target: '' }
  }

  // Blocked on the reader outranks anything the agent was doing when it stopped to ask.
  const permission = state.permissions[0]
  if (permission !== undefined) {
    return { tone: 'you', verb: 'waiting on you', target: permission.title }
  }
  const question = state.questions[0]?.questions[0]
  if (question !== undefined) {
    return { tone: 'you', verb: 'waiting on you', target: question.question }
  }
  if (state.planReview !== null) {
    return { tone: 'you', verb: 'waiting on you', target: 'review the plan' }
  }

  if (state.status === 'working') {
    const doing = nowDoing(state.transcript)
    if (doing.kind === 'thinking') return { tone: 'live', verb: 'thinking', target: '' }
    const verb = VERBS[doing.toolKind]
    // A tool with no verb of its own (an MCP tool, a todo list) is named by its title instead.
    const target = briefTitle(doing.title)
    return verb === undefined
      ? { tone: 'live', verb: 'using', target }
      : { tone: 'live', verb, target }
  }

  // A system-composed queued item was never the reader's, so it is not counted as theirs.
  const queued = state.queued.filter((message) => message.origin !== 'system').length
  return {
    tone: 'idle',
    verb: 'idle',
    target: queued === 0 ? '' : `${queued} queued, sends on the next turn`,
  }
}
