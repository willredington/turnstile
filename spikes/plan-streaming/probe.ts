/**
 * Feasibility probe: can plan revisions stream in, and stay scoped to the sections the
 * feedback was about? Throwaway — not part of the app, imports nothing from `src/` except the
 * two pure edit functions a real `edit_plan` would reuse.
 *
 *   bun spikes/plan-streaming/probe.ts <mode> <runLabel>
 *     mode: rewrite — refuse round 1, let the agent resubmit however it likes (status quo)
 *           edit    — same refusal, but offer `edit_plan` and ask for it
 *
 * Writes `spikes/plan-streaming/logs/<mode>-<runLabel>.json`: every tool-input delta with a
 * timestamp, both rounds' plans, what ExitPlanMode's `input.plan` held versus the plan file on
 * disk, and which plan tools were called.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type CanUseTool,
  createSdkMcpServer,
  query,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { proposedContent, resolveEdit } from '../../src/app/editResolution.ts'

const mode = process.argv[2] as 'rewrite' | 'edit'
const label = process.argv[3] ?? '1'
if (mode !== 'rewrite' && mode !== 'edit') throw new Error('mode: rewrite | edit')

const plansDir = join(homedir(), '.claude', 'plans')
const logsDir = join(import.meta.dir, 'logs')
mkdirSync(logsDir, { recursive: true })

// A tiny but real project, so the plan has something concrete to be about.
const repo = mkdtempSync(join(tmpdir(), 'plan-probe-'))
writeFileSync(
  join(repo, 'todo.ts'),
  `export type Todo = { id: number; title: string; done: boolean }\n\n` +
    `const todos: Todo[] = []\n\n` +
    `export function add(title: string): Todo {\n  const todo = { id: todos.length + 1, title, done: false }\n  todos.push(todo)\n  return todo\n}\n\n` +
    `export function complete(id: number): void {\n  const todo = todos.find((t) => t.id === id)\n  if (todo) todo.done = true\n}\n\n` +
    `export function list(): Todo[] {\n  return [...todos]\n}\n`,
)
writeFileSync(
  join(repo, 'server.ts'),
  `import { add, complete, list } from './todo.ts'\n\n` +
    `Bun.serve({\n  port: 3000,\n  async fetch(req) {\n    const url = new URL(req.url)\n` +
    `    if (req.method === 'GET' && url.pathname === '/todos') return Response.json(list())\n` +
    `    if (req.method === 'POST' && url.pathname === '/todos') {\n      const { title } = await req.json()\n      return Response.json(add(title))\n    }\n` +
    `    if (req.method === 'POST' && url.pathname.startsWith('/todos/')) {\n      complete(Number(url.pathname.split('/')[2]))\n      return new Response(null, { status: 204 })\n    }\n` +
    `    return new Response('not found', { status: 404 })\n  },\n})\n`,
)
execFileSync('git', ['init', '-q'], { cwd: repo })
execFileSync('git', ['add', '.'], { cwd: repo })
execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-qm', 'init'], {
  cwd: repo,
})

const TASK =
  'Plan how to add due dates, priorities, and persistence to SQLite for this todo app. ' +
  'Organise the plan under exactly these level-2 headings, in this order: ' +
  '## Context, ## Data model, ## Persistence, ## API changes, ## Testing, ## Rollout. ' +
  'Be thorough — a few paragraphs or lists per section. Write the plan file, then submit it ' +
  'with ExitPlanMode.'

const TARGET = '## Testing'
const NOTE =
  'The human did not accept this plan, and left a note on it:\n\n' +
  `- the "${TARGET}" section — Do not use snapshot or golden-file tests anywhere; use ` +
  'table-driven unit tests for the data layer and one end-to-end test that starts the server.\n\n' +
  (mode === 'edit'
    ? 'Change only what this note is about. Revise the plan file in place with ' +
      'mcp__probe__edit_plan (old_text/new_text) — do not rewrite the whole file with ' +
      'write_plan — then submit it again with ExitPlanMode. Do not start the work.'
    : 'Revise the plan to address this and submit the new version with ExitPlanMode. Do not ' +
      'start the work, and do not reply with the changes in prose.')

// ---- recording ---------------------------------------------------------------------------

const t0 = Date.now()
type Delta = { t: number; tool: string; bytes: number }
const log = {
  mode,
  label,
  model: '' as string,
  claudeCodeVersion: '' as string,
  deltas: [] as Delta[],
  toolCalls: [] as { t: number; name: string; bytes: number }[],
  rounds: [] as {
    t: number
    inputKeys: string[]
    inputPlan: string
    planFile: string | null
    planFilePath: string | null
    matchesFile: boolean | null
  }[],
  error: null as string | null,
}

let lastPlanPath: string | null = null

// ---- tools -------------------------------------------------------------------------------

function planPath(requested: string): string {
  return join(plansDir, basename(requested))
}

const writePlan = tool(
  'write_plan',
  'Write your plan file. Edit and Write are unavailable. Give the file name the harness told ' +
    "you to use; only the name is used, and the file lands in this session's plan directory.",
  { path: z.string(), content: z.string() },
  async (args: { path: string; content: string }) => {
    const p = planPath(args.path)
    mkdirSync(plansDir, { recursive: true })
    writeFileSync(p, args.content)
    lastPlanPath = p
    return { content: [{ type: 'text' as const, text: `Wrote ${p}.` }] }
  },
)

const editPlan = tool(
  'edit_plan',
  'Replace one exact passage of your plan file with new text, leaving everything else as it ' +
    'is. old_text must match the file exactly. Prefer this over write_plan for revisions.',
  { path: z.string(), old_text: z.string(), new_text: z.string() },
  async (args: { path: string; old_text: string; new_text: string }) => {
    const p = planPath(args.path)
    let current: string | null = null
    try {
      current = readFileSync(p, 'utf8')
    } catch {}
    const check = resolveEdit(basename(p), current, args.old_text)
    if (!check.ok)
      return { content: [{ type: 'text' as const, text: check.message }], isError: true }
    writeFileSync(p, proposedContent(current, args.old_text, args.new_text))
    lastPlanPath = p
    return { content: [{ type: 'text' as const, text: `Edited ${p}.` }] }
  },
)

const server = createSdkMcpServer({
  name: 'probe',
  tools: mode === 'edit' ? [writePlan, editPlan] : [writePlan],
})

// ---- the conversation --------------------------------------------------------------------

let finish: () => void = () => {}
const finished = new Promise<void>((r) => {
  finish = r
})

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: TASK },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage
  await finished
}

const canUseTool: CanUseTool = async (toolName, input) => {
  if (toolName.endsWith('write_plan') || toolName.endsWith('edit_plan'))
    return { behavior: 'allow' }
  if (toolName === 'ExitPlanMode') {
    const inputPlan = typeof input.plan === 'string' ? input.plan : ''
    const filePath =
      typeof input.planFilePath === 'string' ? (input.planFilePath as string) : lastPlanPath
    let planFile: string | null = null
    try {
      planFile = filePath === null ? null : readFileSync(filePath, 'utf8')
    } catch {}
    log.rounds.push({
      t: Date.now() - t0,
      inputKeys: Object.keys(input),
      inputPlan,
      planFile,
      planFilePath: filePath,
      matchesFile: planFile === null ? null : planFile === inputPlan,
    })
    if (log.rounds.length === 1) return { behavior: 'deny', message: NOTE }
    finish()
    return { behavior: 'deny', message: 'Recorded. That is all — end your turn now.' }
  }
  // Read-only exploration is fine; anything else is out of scope for a planning probe.
  if (['Read', 'Glob', 'Grep', 'LS'].includes(toolName)) return { behavior: 'allow' }
  if (
    toolName === 'Bash' &&
    /^(ls|cat|git (status|log|diff)|head|wc)\b/.test(String(input.command))
  )
    return { behavior: 'allow' }
  return { behavior: 'deny', message: 'Not available in this probe — plan only.' }
}

const blockTool = new Map<number, string>()
const blockBytes = new Map<number, number>()

const q = query({
  prompt: prompt(),
  options: {
    cwd: repo,
    permissionMode: 'plan',
    includePartialMessages: true,
    disallowedTools: ['Edit', 'Write'],
    mcpServers: { probe: server },
    canUseTool,
    env: { ...process.env },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'Write your plan file with the mcp__probe__write_plan tool rather than with a shell ' +
        'command; it is the only way to write it here, and it works while plan mode is on.' +
        (mode === 'edit' ? ' Revise an existing plan with mcp__probe__edit_plan.' : ''),
    },
  },
})

const timeout = setTimeout(() => {
  log.error = 'timeout'
  finish()
  void q.interrupt().catch(() => {})
}, 8 * 60_000)

try {
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') {
      log.model = message.model
      log.claudeCodeVersion = message.claude_code_version ?? ''
    }
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const e = message.event as {
        type: string
        index?: number
        content_block?: { type: string; name?: string }
        delta?: { type: string; partial_json?: string }
      }
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        blockTool.set(e.index ?? -1, e.content_block.name ?? '?')
        blockBytes.set(e.index ?? -1, 0)
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        const name = blockTool.get(e.index ?? -1) ?? '?'
        const bytes = e.delta.partial_json?.length ?? 0
        log.deltas.push({ t: Date.now() - t0, tool: name, bytes })
        blockBytes.set(e.index ?? -1, (blockBytes.get(e.index ?? -1) ?? 0) + bytes)
      } else if (e.type === 'content_block_stop' && blockTool.has(e.index ?? -1)) {
        log.toolCalls.push({
          t: Date.now() - t0,
          name: blockTool.get(e.index ?? -1) ?? '?',
          bytes: blockBytes.get(e.index ?? -1) ?? 0,
        })
        blockTool.delete(e.index ?? -1)
      }
    }
    if (message.type === 'result') break
  }
} catch (error) {
  log.error = error instanceof Error ? error.message : String(error)
} finally {
  clearTimeout(timeout)
  finish()
}

const out = join(logsDir, `${mode}-${label}.json`)
writeFileSync(out, JSON.stringify(log, null, 2))
console.log(
  `${out}: ${log.rounds.length} round(s), ${log.deltas.length} deltas, error=${log.error}`,
)
process.exit(0)
