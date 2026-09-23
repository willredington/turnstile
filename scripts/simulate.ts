import { serveApp } from '../src/adapters/web/server.ts'
import { createAutoMode } from '../src/app/autoMode.ts'
import { PLAN_PATH } from '../src/core/annotations.ts'
import type { AutoModePolicy } from '../src/core/autoMode.ts'
import type {
  Asker,
  ProjectTree,
  RepoReader,
  RootHandle,
  RootRegistry,
  Session,
} from '../src/core/ports.ts'
import type {
  DiffFile,
  DiffView,
  FileRef,
  LiveChunk,
  ParsedPatch,
  SessionState,
} from '../src/core/types.ts'

/**
 * A fake session, driving the real web UI without a real agent, model, or git repo.
 *
 * There is no automated check for "does this look right" — this is the harness that stands
 * in for one. `package.json`'s `simulate` script has pointed here since before this file
 * existed; this is what fills that in. Run with `bun run simulate` (or `bun scripts/
 * simulate.ts` directly) and open the URL it prints.
 */

/** This harness simulates a single-root session — a synthetic root path is enough. */
const SIM_ROOT = '/repo'

function line(
  kind: 'add' | 'remove' | 'context',
  oldLine: number | null,
  newLine: number | null,
  text: string,
) {
  return { kind, oldLine, newLine, text }
}

const RISK_TS_PATCH: ParsedPatch = {
  kind: 'modified',
  path: 'src/core/risk.ts',
  addedCount: 2,
  removedCount: 1,
  hunks: [
    {
      oldStart: 39,
      newStart: 39,
      context: 'export function isSubstantive(',
      lines: [
        line('context', 41, 41, '  if (isGenerated(path)) return false'),
        line('context', 42, 42, '  if (alwaysReview(path)) return true'),
        line('remove', 43, null, '  if (indentationSensitive(path)) return true'),
        line('add', null, 43, '  if (commentOnly(diff)) return false'),
        line('add', null, 44, '  if (indentationSensitive(path)) return true'),
        line('context', 44, 45, '  if (whitespaceOnly(diff)) return false'),
        line('context', 45, 46, '  return true'),
      ],
    },
    {
      oldStart: 88,
      newStart: 89,
      context: '',
      lines: [
        line('context', 88, 89, '  const label = riskLabel(level)'),
        line('add', null, 90, '  const flagged = isRisky(level)'),
        line('context', 89, 91, '  return { label }'),
      ],
    },
  ],
}

function simplePatch(path: string, text: string): ParsedPatch {
  return {
    kind: 'modified',
    path,
    addedCount: 1,
    removedCount: 1,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        context: '',
        lines: [line('remove', 1, null, `- ${text}`), line('add', null, 1, `+ ${text}`)],
      },
    ],
  }
}

function chunk(overrides: Partial<LiveChunk> & Pick<LiveChunk, 'key' | 'path'>): LiveChunk {
  return {
    contentKey: overrides.key,
    root: SIM_ROOT,
    startLine: 41,
    endLine: 58,
    kind: 'modified',
    status: 'ready',
    analysis: { riskLevel: 'none', findings: [] },
    reason: null,
    ...overrides,
  }
}

const CHUNKS: LiveChunk[] = [
  chunk({
    key: 'risk-1',
    path: 'src/core/risk.ts',
    startLine: 41,
    endLine: 58,
    analysis: {
      riskLevel: 'high',
      findings: [
        {
          path: 'src/core/risk.ts',
          startLine: 44,
          endLine: 46,
          severity: 'high',
          title: 'Comment check ignores string contents',
          message:
            'A `//` inside a string literal is read as a comment, so a change that edits a URL ' +
            'in a string is skipped as comment-only and never reviewed.',
        },
        {
          path: 'src/core/risk.ts',
          startLine: 52,
          endLine: 52,
          severity: 'medium',
          title: 'File read in core',
          message:
            '`readFileSync` here puts I/O in core/, which the architecture test forbids — the ' +
            'build fails on it.',
        },
      ],
    },
  }),
  chunk({
    key: 'risk-2',
    path: 'src/core/risk.ts',
    startLine: 88,
    endLine: 94,
    analysis: { riskLevel: 'none', findings: [] },
  }),
  chunk({
    key: 'gate-1',
    path: 'src/app/gate.ts',
    startLine: 12,
    endLine: 20,
    // Changed since its last review — what "Review now" is for.
    status: 'pending',
    analysis: null,
  }),
  chunk({
    key: 'other-1',
    path: 'src/core/other.ts',
    startLine: 5,
    endLine: 9,
  }),
  chunk({
    key: 'types-1',
    path: 'src/core/types.ts',
    startLine: 14,
    endLine: 18,
  }),
  chunk({
    key: 'risktest-1',
    path: 'tests/core/risk.test.ts',
    startLine: 22,
    endLine: 30,
  }),
  chunk({
    key: 'readme-1',
    path: 'README.md',
    status: 'skipped',
    analysis: null,
    reason: 'documentation',
  }),
  chunk({
    key: 'lock-1',
    path: 'bun.lock',
    status: 'skipped',
    analysis: null,
    reason: 'generated',
  }),
]

const DIFF_FILES: DiffFile[] = [
  { root: SIM_ROOT, path: 'src/core/risk.ts', status: 'Modified', patch: RISK_TS_PATCH },
  {
    root: SIM_ROOT,
    path: 'src/app/gate.ts',
    status: 'Modified',
    patch: simplePatch('src/app/gate.ts', 'gate change'),
  },
  {
    root: SIM_ROOT,
    path: 'src/core/other.ts',
    status: 'Modified',
    patch: simplePatch('src/core/other.ts', 'other change'),
  },
  // A changed binary file: it belongs on the board (it did change) but has no document to
  // render under the diff. There is no other way to eyeball that state.
  {
    root: SIM_ROOT,
    path: 'docs/handbook.pdf',
    status: 'Modified',
    patch: simplePatch('docs/handbook.pdf', 'binary change'),
  },
]

/**
 * A file long enough for its own patch to be honest about where its changes are.
 *
 * `RISK_TS_PATCH` quotes lines 41–46 and 89–91, so the file has to actually have them. A patch
 * whose numbers disagree with the file it describes cannot happen in the real app — both sides
 * come from the same pair of git trees (`app/board.ts`'s `captureBoardFor`) — and a harness
 * that fakes one only teaches the UI to render something it will never be handed. This used to
 * be a 13-line file with changes claimed at line 44.
 */
function riskFile(): string {
  const lines = new Array<string>(95).fill('')
  const put = (n: number, text: string): void => {
    lines[n - 1] = text
  }

  put(1, "import { commentOnly, whitespaceOnly } from './diffshape.ts'")
  put(2, "import type { Delta, RiskLevel } from './types.ts'")

  put(4, '/** Paths nobody wants a review of, however they changed. */')
  put(5, 'const NEVER = [/\\.lock$/, /^vendor\\//, /^dist\\//]')
  put(6, 'const GENERATED = [/\\.snap$/, /^node_modules\\//]')
  put(7, "const INDENTED = ['.py', '.yaml', '.yml']")

  put(9, 'function neverReview(path: string): boolean {')
  put(10, '  return NEVER.some((pattern) => pattern.test(path))')
  put(11, '}')

  put(13, 'function isGenerated(path: string): boolean {')
  put(14, '  return GENERATED.some((pattern) => pattern.test(path))')
  put(15, '}')

  put(17, 'function alwaysReview(path: string): boolean {')
  put(18, "  return path.startsWith('migrations/') || path.startsWith('src/auth/')")
  put(19, '}')

  put(21, '/** Reindenting Python is a behaviour change made entirely of whitespace. */')
  put(22, 'function indentationSensitive(path: string): boolean {')
  put(23, '  return INDENTED.some((extension) => path.endsWith(extension))')
  put(24, '}')

  put(26, 'function riskLabel(level: RiskLevel): string {')
  put(27, '  switch (level) {')
  put(28, "    case 'high':")
  put(29, "      return 'needs a read'")
  put(30, "    case 'medium':")
  put(31, "      return 'worth a look'")
  put(32, '    default:')
  put(33, "      return 'no findings'")
  put(34, '  }')
  put(35, '}')

  put(38, '/** Every heuristic errs toward gating: a false gate costs one review. */')
  put(39, 'export function isSubstantive(path: string, diff: Delta): boolean {')
  put(40, '  if (neverReview(path)) return false')
  put(41, '  if (isGenerated(path)) return false')
  put(42, '  if (alwaysReview(path)) return true')
  put(43, '  if (commentOnly(diff)) return false')
  put(44, '  if (indentationSensitive(path)) return true')
  put(45, '  if (whitespaceOnly(diff)) return false')
  put(46, '  return true')
  put(47, '}')

  put(50, '/** Which files are worth the model call, and why a skipped one was skipped. */')
  put(51, 'export function skipReason(path: string, diff: Delta): string | null {')
  put(52, "  if (isGenerated(path)) return 'generated'")
  put(53, "  if (neverReview(path)) return 'vendored'")
  put(54, "  if (commentOnly(diff)) return 'comment-only'")
  put(55, "  if (whitespaceOnly(diff)) return 'formatting'")
  put(56, '  return null')
  put(57, '}')

  put(60, 'export function isRisky(level: RiskLevel): boolean {')
  put(61, "  return level === 'high' || level === 'medium'")
  put(62, '}')

  put(65, '/** The worst of a set of findings is what the change is worth. */')
  put(66, 'export function worst(levels: RiskLevel[]): RiskLevel {')
  put(67, "  if (levels.includes('high')) return 'high'")
  put(68, "  if (levels.includes('medium')) return 'medium'")
  put(69, "  if (levels.includes('low')) return 'low'")
  put(70, "  return 'none'")
  put(71, '}')

  put(74, 'export function order(levels: RiskLevel[]): RiskLevel[] {')
  put(75, '  const rank = { high: 0, medium: 1, low: 2, none: 3 }')
  put(76, '  return [...levels].sort((a, b) => rank[a] - rank[b])')
  put(77, '}')

  put(80, 'export function countBy(levels: RiskLevel[]): Record<string, number> {')
  put(81, '  const out: Record<string, number> = {}')
  put(82, '  for (const level of levels) out[level] = (out[level] ?? 0) + 1')
  put(83, '  return out')
  put(84, '}')

  put(87, '/** What the tab strip says about a change. */')
  put(88, 'export function describe(level: RiskLevel): { label: string } {')
  put(89, '  const label = riskLabel(level)')
  put(90, '  const flagged = isRisky(level)')
  put(91, '  return { label }')
  put(92, '}')

  return lines.join('\n')
}

const FILE_CONTENTS: Record<string, string> = {
  'src/core/risk.ts': riskFile(),
  'README.md': '# Turnstile\n\nA turn-boundary code review tool.\n',
}

let revision = 0
let diffRevision = 0

/**
 * A plan with enough shape to actually review: headings, numbered steps, and lines worth
 * disagreeing with. Turning plan mode on in the simulator submits it, which is the only way to
 * reach the plan surface with no model, no key and no agent.
 */
const FIXTURE_PLAN = `# React frontend + Python backend for whatsapp-wordfreq

## Context

The whole project is one 449-line stdlib-only Python file, \`wordfreq.py\`. It reads a WhatsApp
export, analyzes it, and writes a self-contained HTML file — the report's entire CSS and
JavaScript live inside a Python string literal (\`TEMPLATE\`, \`wordfreq.py:256-410\`).

The presentation layer is unmaintainable: editing the UI means editing JavaScript inside a
Python raw string, with no build step, no types, and no component reuse.

**Outcome:** drag a WhatsApp \`.zip\` into a web page, get the same seven-section report back,
rendered by React — no CLI, no rebuild, no committed artifact.

## Decisions

| Decision | Choice |
| --- | --- |
| Input | Browser uploads the whole \`.zip\` to \`POST /api/analyze\`, 100 MB cap, no server-side state |
| Frontend language | TypeScript |
| Visual target | 1:1 port of the current report, **Recharts** for the four bar-based sections |
| Backend framework | FastAPI + uvicorn (first-ever dependency; project is stdlib-only today) |
| Deployment | Full containerization: per-service Dockerfiles + \`compose.yaml\` |

## Target structure

\`\`\`
backend/
  wordfreq/
    __init__.py        # re-exports the public API
    analysis.py        # regexes, STOPWORDS, parse/tokenize/count/distinctive/shared/burst
    chat.py            # read_chat, now accepting a path OR a file-like object
    report.py          # build_report() unchanged — still returns a plain dict
  api.py               # FastAPI app: POST /api/analyze
  Dockerfile
frontend/
  src/
    App.tsx
    sections/          # one component per report section
    charts/            # Recharts wrappers carrying the palette
  Dockerfile
compose.yaml
\`\`\`

## Steps

1. Split \`wordfreq.py\` into the package above, moving functions unchanged.
2. Make \`read_chat\` accept a file-like object as well as a path.
3. Add \`api.py\` with a single \`POST /api/analyze\` endpoint.
4. Scaffold the React app with Vite and TypeScript.
5. Port each of the seven report sections to a component.
6. Wrap the four bar-based sections in Recharts, passing the existing palette through.
7. Write the two Dockerfiles and \`compose.yaml\`.
8. Delete \`TEMPLATE\` and the CLI's HTML-writing path.

## Risks

Step 8 deletes the only way to produce a report without Docker, which is how the tool is used
today. The palette carries over unchanged — the existing series colors were validated against
the dataviz CVD/WCAG checks in both modes and all six checks pass, so no color work is needed.

## Verification

Run \`compose up\`, drag a real export in, and diff the rendered sections against a report built
by the current CLI from the same file.`

let state: SessionState = {
  status: 'idle',
  fileFindings: [],
  tracking: 'git',
  baseline: 'session-start',
  sessionId: 'sim-1',
  transcript: [
    {
      kind: 'user',
      text: 'The risk bar is gating comment-only edits in Python files. Fix it and add a test.',
      at: '2026-01-01T10:00:00.000Z',
    },
    // A plan that was decided earlier in this session — what a resumed session replays, and
    // what a live one keeps once the plan tab has gone.
    {
      kind: 'plan',
      text: FIXTURE_PLAN,
      round: 2,
      outcome: 'sent-back',
      at: '2026-01-01T10:00:30.000Z',
    },
    // Sending it back, as the reader sees it: their own words, with their notes beside them —
    // never the composed refusal the agent was handed.
    {
      kind: 'user',
      text: 'otherwise fine',
      at: '2026-01-01T10:00:40.000Z',
      notes: [
        {
          path: PLAN_PATH,
          line: 263,
          rangeStart: 262,
          side: 'new',
          lineText: 'backend/Dockerfile — python:3.12-slim, pip install requirements',
          body: 'can you use a hardened image',
        },
      ],
    },
    {
      kind: 'thought',
      text: 'The comment-only check is probably short-circuited before it runs for .py. Look at the order of the predicates.',
      at: '2026-01-01T10:00:01.000Z',
    },
    {
      kind: 'assistant',
      text:
        'Found it. `isSubstantive` checks the indentation-sensitive extension list before the ' +
        'comment-only test, so any .py or .yaml edit gates regardless of content.',
      at: '2026-01-01T10:00:03.000Z',
    },
    {
      kind: 'tool',
      id: 't1',
      title: 'src/core/risk.ts',
      toolKind: 'read',
      status: 'completed',
      at: '2026-01-01T10:00:04.000Z',
      endedAt: '2026-01-01T10:00:05.000Z',
    },
    {
      kind: 'tool',
      id: 't2',
      title: 'src/core/risk.ts · 2 regions',
      toolKind: 'edit',
      status: 'completed',
      at: '2026-01-01T10:00:05.000Z',
      endedAt: '2026-01-01T10:00:07.000Z',
    },
    {
      kind: 'subagent',
      taskId: 'task-1',
      toolUseId: 't3',
      status: 'running',
      description: 'Inspect report sections and PDF provenance',
      subagentType: 'explore',
      lastToolName: 'Bash',
      toolUses: 8,
      summary: null,
      at: '2026-01-01T10:00:07.000Z',
      endedAt: null,
    },
    {
      kind: 'subagent',
      taskId: 'task-2',
      toolUseId: 't4',
      status: 'completed',
      description: 'Check the risk bar against the extension list',
      subagentType: 'general-purpose',
      lastToolName: 'Grep',
      toolUses: 3,
      summary: 'The list is only consulted from `isSubstantive`, so the reorder is safe.',
      at: '2026-01-01T10:00:07.000Z',
      endedAt: '2026-01-01T10:00:08.000Z',
    },
    {
      kind: 'notice',
      text: 'Turn ended.',
      tone: 'info',
      at: '2026-01-01T10:00:08.000Z',
    },
  ],
  permissions: [],
  questions: [],
  revision: revision++,
  diffRevision: diffRevision++,
  roots: [{ root: SIM_ROOT }],
  chunks: CHUNKS,
  hidden: [],
  annotations: [
    {
      id: 'note-1',
      sessionId: 'sim-1',
      root: SIM_ROOT,
      path: 'src/core/risk.ts',
      line: 43,
      rangeStart: 43,
      side: 'new',
      lineText: '  if (commentOnly(diff)) return false',
      body: 'This returns before the whitespace check — is that deliberate?',
      at: new Date().toISOString(),
      sentAt: null,
    },
    {
      id: 'note-orphan',
      sessionId: 'sim-1',
      root: SIM_ROOT,
      path: 'src/core/vanished.ts',
      line: 12,
      rangeStart: 12,
      side: 'new',
      lineText: 'const x = 1',
      body: 'The agent reverted this file after the note was left.',
      at: new Date(Date.now() - 60_000).toISOString(),
      sentAt: null,
    },
    {
      id: 'note-sent',
      sessionId: 'sim-1',
      root: SIM_ROOT,
      path: 'src/core/other.ts',
      line: 7,
      rangeStart: 7,
      side: 'new',
      lineText: "  help: '## Show this help',",
      body: "on second thought we don't actually need a help command",
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      sentAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
  ],
  queued: [
    { id: 'q1', text: 'Also cover .yaml and .yml in the test.', at: new Date().toISOString() },
  ],
  model: 'Claude Sonnet 5',
  thinkingLevel: 'high',
  contextUsed: 48_213,
  contextSize: 200_000,
  planMode: 'default',
  planReview: null,
}

type Listener = (next: SessionState) => void
let listener: Listener = () => {}

function commit(patch: Partial<SessionState>): void {
  state = { ...state, ...patch, revision: revision++ }
  listener(state)
}

const fakeSession: Session = {
  state: () => state,
  initRepository: async () => {},
  diff: async (): Promise<DiffView> => ({
    base: 'sim-base',
    files: DIFF_FILES,
    error: null,
    branch: 'feat/comment-only-risk',
  }),
  start: async () => {},
  newSession: async () => {},
  resumeSession: async () => {},
  listSessions: async () => [
    {
      sessionId: 'sim-old-1',
      title: 'Fix comment-only risk-bar gate',
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      sessionId: 'sim-old-2',
      title: null,
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
  send: async (text: string) => {
    commit({
      transcript: [...state.transcript, { kind: 'user', text, at: new Date().toISOString() }],
    })
  },
  answerPermission: () => {},
  answerQuestion: () => {},
  writeFile: async () => ({ decision: 'allow' as const, fileContent: '' }),
  /** Writes into the harness's own file table, so editing can be driven here without a repo. */
  saveFile: async (file, text) => {
    FILE_CONTENTS[file.path] = text
    diffRevision += 1
    commit({ diffRevision })
    return { ok: true as const }
  },
  queue: (text: string) => {
    commit({
      queued: [...state.queued, { id: `q${Date.now()}`, text, at: new Date().toISOString() }],
    })
  },
  unqueue: (id: string) => {
    commit({ queued: state.queued.filter((message) => message.id !== id) })
  },
  sendNotes: async () => {
    const at = new Date().toISOString()
    commit({
      annotations: state.annotations.map((annotation) =>
        annotation.sentAt === null ? { ...annotation, sentAt: at } : annotation,
      ),
    })
  },
  // A real note, not a no-op: a note arriving on a document that is already on screen is its
  // own case — the card is a block widget the editor has to make room for — and it cannot be
  // exercised at all if leaving one here does nothing.
  annotate: async (input) => {
    commit({
      annotations: [
        ...state.annotations,
        {
          id: `sim-note-${state.annotations.length + 1}`,
          sessionId: state.sessionId ?? 'sim',
          root: input.root,
          path: input.path,
          line: input.line,
          rangeStart: input.rangeStart ?? input.line,
          side: input.side,
          lineText: input.lineText,
          body: input.body,
          at: new Date().toISOString(),
          sentAt: null,
        },
      ],
    })
  },
  removeAnnotation: async (id: string) => {
    commit({ annotations: state.annotations.filter((annotation) => annotation.id !== id) })
  },
  hideFile: async (file: FileRef) => {
    commit({ hidden: [...state.hidden, file] })
  },
  // Every unreviewed chunk goes under review, and a moment later comes back clean.
  reviewNow: () => {
    commit({
      chunks: state.chunks.map((chunk) =>
        chunk.status === 'pending' ? { ...chunk, status: 'analyzing', reason: null } : chunk,
      ),
    })
    setTimeout(() => {
      commit({
        chunks: state.chunks.map((chunk) =>
          chunk.status === 'analyzing' && chunk.analysis === null
            ? { ...chunk, status: 'ready', analysis: { riskLevel: 'none', findings: [] } }
            : chunk,
        ),
      })
    }, 1500)
  },
  showFile: async (file: FileRef) => {
    commit({
      hidden: state.hidden.filter(
        (hidden) => !(hidden.root === file.root && hidden.path === file.path),
      ),
    })
  },
  // Turning plan mode on submits the fixture plan straight away. The real session gets here by
  // the agent calling `ExitPlanMode`, which the simulator has no agent to do.
  enterPlanMode: async () => {
    commit({
      planMode: 'plan',
      planReview: {
        plan: FIXTURE_PLAN,
        round: (state.planReview?.round ?? 0) + 1,
        notes: [],
        recovered: false,
      },
    })
  },
  exitPlanMode: async () => {
    commit({ planMode: 'default', planReview: null })
  },
  approvePlan: () => {
    commit({ planMode: 'default', planReview: null })
  },
  // Sending back resubmits, so the revision counter and "notes cleared on a new round" are both
  // exercisable without an agent.
  rejectPlan: () => {
    const pending = state.planReview
    if (pending === null) return
    commit({
      planReview: { plan: FIXTURE_PLAN, round: pending.round + 1, notes: [], recovered: false },
    })
  },
  annotatePlan: (input) => {
    const pending = state.planReview
    if (pending === null) return
    commit({
      planReview: {
        ...pending,
        notes: [
          ...pending.notes,
          {
            id: `plan-note-${pending.notes.length + 1}`,
            sessionId: state.sessionId ?? 'sim',
            root: '',
            path: PLAN_PATH,
            line: input.line,
            rangeStart: input.rangeStart,
            side: 'new',
            lineText: input.lineText,
            body: input.body,
            at: new Date().toISOString(),
            sentAt: null,
          },
        ],
      },
    })
  },
  removePlanNote: (id) => {
    const pending = state.planReview
    if (pending === null) return
    commit({ planReview: { ...pending, notes: pending.notes.filter((note) => note.id !== id) } })
  },
  cancel: async () => {},
  stop: () => {},
}

const fakeProjectTree: ProjectTree = {
  list: async () => [
    'src/core/risk.ts',
    'src/core/types.ts',
    'src/core/other.ts',
    'src/app/gate.ts',
    'src/adapters/git/commands.ts',
    'tests/core/risk.test.ts',
    'README.md',
    'bun.lock',
    'package.json',
    'docs/handbook.pdf',
  ],
  read: async (_root: string, path: string) =>
    path.endsWith('.pdf')
      ? { kind: 'binary' as const }
      : {
          kind: 'text' as const,
          text: FILE_CONTENTS[path] ?? `// ${path}\n// (simulated content)\n`,
        },
}

// Single simulated root — the live session's worktree, as far as the server can tell.
const simRoot: RootHandle = {
  root: SIM_ROOT,
  snapshots: {
    capture: async () => 'sim',
    delta: async () => [],
    patch: async () => '',
    contents: async () => null,
  },
  baseline: {
    resolve: async () => ({ tree: 'sim', source: 'session-start', branch: null }),
  },
}

/**
 * An asker that takes a beat and then says something about what it was shown.
 *
 * The delay is the point: an answer that arrives instantly never exercises the pending state,
 * and "several seconds of silence" is the thing the spinner exists for.
 */
const fakeAsker: Asker = {
  ask: async ({ payload }) => {
    await new Promise((resolve) => setTimeout(resolve, 900))
    const question = payload.slice(payload.lastIndexOf('## The question') + 16).trim()
    return [
      `Simulated answer to **${question}**`,
      '',
      'It is wired through `core/ask.ts` and rendered as Markdown, so `inline code`, a link',
      'to `src/core/tabs.ts:12`, and a list all have somewhere to land:',
      '',
      `- the payload was ${payload.length} characters`,
      '- no model was called',
      '- nothing was written anywhere',
    ].join('\n')
  },
}

const fakeReader: RepoReader = {
  read: async () => null,
  glob: async () => ({ paths: [], truncated: false }),
  grep: async () => ({ matches: [], truncated: false }),
}

const fakeRoots: RootRegistry = {
  knownRoots: () => [simRoot],
  activate: () => simRoot,
  deactivate: () => {},
  rootFor: () => simRoot,
  teardown: async () => {},
}

/**
 * Auto-mode with a judge that matches words instead of asking a model: a command sharing a word
 * with a statement ("git push" and "…(git push, …)") scores high, anything else low. Enough to
 * drive the setup screen and its "Try a command" box with no key. Starts with nothing saved, so
 * the page opens on setup, as a first run does.
 */
let simulatedPolicy: AutoModePolicy | null = null
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []
const fakeAutoMode = createAutoMode({
  store: {
    load: async () => simulatedPolicy,
    save: async (policy) => {
      simulatedPolicy = policy
    },
  },
  judge: {
    judge: async (state, rules) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const said = new Set(wordsOf(String(state.call.command ?? state.call.input)))
      return new Map(
        rules.map((rule) => [
          rule.id,
          wordsOf(rule.text).some((word) => said.has(word)) ? 0.85 : 0.04,
        ]),
      )
    },
  },
  where: { cwd: process.cwd(), home: process.env.HOME ?? '/' },
  timeoutMs: 5_000,
})
await fakeAutoMode.load()

const server = serveApp({
  session: fakeSession,
  projectTree: fakeProjectTree,
  asker: fakeAsker,
  reader: fakeReader,
  roots: fakeRoots,
  cwd: process.cwd(),
  autoMode: fakeAutoMode,
  onListening: (url) => {
    process.stdout.write(`turnstile (simulated): ${url}\n`)
  },
})
listener = server.broadcast
