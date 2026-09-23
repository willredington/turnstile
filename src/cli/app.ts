import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentHistory, createAgentSdkClient } from '../adapters/agent-sdk/client.ts'
import { createAgentSdkReviewer } from '../adapters/agent-sdk/reviewer.ts'
import { createFileAnnotationStore } from '../adapters/fs/annotations.ts'
import { loadConfig } from '../adapters/fs/config.ts'
import { createFileEditTarget } from '../adapters/fs/editTarget.ts'
import { createFileFindingStore } from '../adapters/fs/findings.ts'
import { createFileHiddenStore } from '../adapters/fs/hidden.ts'
import { createProjectTree } from '../adapters/fs/projectTree.ts'
import { createRepoReader } from '../adapters/fs/repoReader.ts'
import { createGitRepository } from '../adapters/git/repository.ts'
import { createGitRootRegistry } from '../adapters/git/rootRegistry.ts'
import { createModelAsker } from '../adapters/model/asker.ts'
import { createModel, readApiKey } from '../adapters/model/client.ts'
import { createOtelTelemetry } from '../adapters/otel/telemetry.ts'
import { serveApp } from '../adapters/web/server.ts'
import { createSession } from '../app/session.ts'
import { STATE_DIR } from '../core/config.ts'
import type { Asker, Session, Telemetry } from '../core/ports.ts'
import { agentTelemetryEnv, noopTelemetry } from '../core/telemetry.ts'
import { watchParent } from './parentWatch.ts'

/**
 * Composition root for the app.
 *
 * The only module allowed to know about every layer at once: it builds the adapters, hands
 * them to the session as ports, and puts a server in front.
 */

function openBrowser(url: string): void {
  if (process.env.TURNSTILE_NO_BROWSER === '1') return
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    Bun.spawn([command, url], { stdout: 'ignore', stderr: 'ignore' }).unref()
  } catch {
    // The URL is printed either way, which is the fallback.
  }
}

export async function runApp(): Promise<void> {
  const cwd = process.cwd()

  const config = await loadConfig(cwd)

  /**
   * Turnstile's own measurements, and the agent's.
   *
   * Two halves that meet in the backend rather than in this process. Turnstile's spans and
   * counters go through the `Telemetry` port; the agent's spans, tokens and cost come from the
   * Claude Code CLI, which is instrumented already and reads its configuration from the
   * environment — `adapters/agent-sdk/client.ts` spreads `process.env` into the subprocess it
   * spawns, so putting the variables here is the whole of that wiring. They are correlated by
   * `session.id`, which both sides stamp on their own spans.
   *
   * Both are off unless `telemetry.enabled` is set, and neither can fail a session: a collector
   * that is down costs the measurements and nothing else.
   */
  const telemetry: Telemetry = config.telemetry.enabled
    ? createOtelTelemetry(config.telemetry)
    : noopTelemetry
  Object.assign(process.env, agentTelemetryEnv(config.telemetry))

  // A read-only view of the repository, for the asker's tools and the file explorer.
  const reader = createRepoReader()
  const annotations = createFileAnnotationStore(cwd)
  const hidden = createFileHiddenStore(cwd)
  const editTarget = createFileEditTarget()
  const projectTree = createProjectTree()

  // Every session works directly in this checkout, measured from a baseline recorded in git at
  // its first prompt; the registry holds the repository, bound to the live session. A `cwd` that
  // is not a git repository opens no session at all until the UI initializes one
  // (`Session.initRepository`).
  const repository = createGitRepository({
    dir: cwd,
    untrackedExcludes: config.untrackedExcludes,
  })
  const roots = createGitRootRegistry({
    excludePrefixes: [STATE_DIR],
    untrackedExcludes: config.untrackedExcludes,
  })

  // Built per call: a missing key must reach the
  // reader as "I cannot answer that" on the question they just asked, not as a failure to start.
  const asker: Asker = {
    ask: (input) =>
      createModelAsker(
        createModel(readApiKey(process.env, config.openrouter.apiKeyEnv), config.ask.model),
        config.ask,
      ).ask(input),
  }

  // Turnstile's own state, kept out of reach of the coding agent and the reviewer alike.
  const protectedDirs = [join(homedir(), STATE_DIR), join(cwd, STATE_DIR)]
  const reservedPaths = [STATE_DIR, ...protectedDirs]

  // A read-only Claude Code run over the files a turn changed, in this checkout — so it loads the
  // repository's own CLAUDE.md and skills, as the coding agent does.
  const reviewer = createAgentSdkReviewer({
    model: config.review.model,
    timeoutMs: config.review.timeoutMs,
    maxTurns: config.review.maxTurns,
    protectedDirs,
    reservedPaths,
  })

  // The session and the server are mutually referential: the session pushes state changes
  // through the server, which does not exist until the session does.
  let broadcast: (state: never) => void = () => {}

  const session: Session = createSession({
    connect: (onEvent, writeFile, requestPlanApproval, sessionCwd) =>
      createAgentSdkClient({
        cwd: sessionCwd,
        onEvent,
        writeFile,
        requestPlanApproval,
        denyPatterns: config.toolPermissions.denyPatterns,
        // Turnstile's own state is not the agent's to read or change. `protectedDirs` is
        // enforced by Claude Code's deny rules and OS sandbox; `reservedPaths` also refuses
        // Turnstile's own write tool, which runs in this process, outside both.
        protectedDirs,
        reservedPaths,
        // Claude Code's own plan directory — outside the repository, and the one place the
        // plan tool can write. Without it the agent has no sanctioned way to write the plan
        // file the harness asks it for, and falls back to a shell redirect.
        plansDir: join(homedir(), '.claude', 'plans'),
      }),
    history: createAgentHistory(cwd),
    roots,
    repository,
    annotations,
    hidden,
    editTarget,
    reviewer,
    findings: createFileFindingStore(cwd),
    config,
    telemetry,
    onChange: (state) => broadcast(state as never),
  })

  const server = serveApp({ session, projectTree, asker, reader, roots, cwd, telemetry })
  broadcast = server.broadcast as (state: never) => void

  await session.start()

  // `turnstile: <url>` on stdout is the one line the desktop app reads to find the server (see
  // `desktop/src-tauri/src/sidecar.rs`), so nothing else goes to stdout with that prefix.
  process.stdout.write(`turnstile: ${server.url}\n`)
  // Off by default, and off looks exactly like an empty backend from the Grafana side — so say
  // which one it is.
  process.stderr.write(
    config.telemetry.enabled
      ? `Telemetry: exporting to ${config.telemetry.endpoint}\n`
      : 'Telemetry: off (set "telemetry": { "enabled": true } in .turnstile/config.json)\n',
  )
  if (session.state().tracking !== 'git') {
    process.stderr.write(
      'This directory is not a git repository, so no session was opened. ' +
        'Initialize one from the app, or run `git init`.\n',
    )
  }
  openBrowser(server.url)

  // Async: `roots.teardown()` drops whatever shouldn't outlive the process. Guarded against
  // firing twice — a second signal arriving while the first shutdown is still awaiting teardown
  // (Ctrl+C held down, or a terminal sending both SIGHUP and SIGTERM as it closes) would
  // otherwise do the work twice.
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      try {
        // Bounded internally, so a stale endpoint cannot stop the process exiting.
        await telemetry.flush()
        await roots.teardown()
      } finally {
        session.stop()
        server.stop()
        process.exit(0)
      }
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // Closing the terminal (a tab, the window) typically sends this rather than SIGINT/SIGTERM —
  // without it, teardown never runs for anyone who stops the app that way rather than Ctrl+C.
  process.on('SIGHUP', shutdown)
  // The desktop app asks for this: its sidecar must not outlive it, however it ended.
  if (process.env.TURNSTILE_EXIT_WITH_PARENT === '1') watchParent(shutdown)

  await new Promise<void>(() => {})
}
