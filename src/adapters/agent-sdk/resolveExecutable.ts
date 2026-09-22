import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Walk upward from `startDir` looking for `relativePath`, stopping at the filesystem root.
 *
 * Ported from the ACP-era `defaultCommand()`'s own helper (`adapters/acp/client.ts`, since
 * removed along with ACP). Exported so the fallback below is testable directly: the bug it
 * defends against only shows up once `bun build --compile` makes `import.meta.url` resolve to
 * a virtual path, which nothing short of an actual compile can reproduce — but the
 * directory-walking logic that takes over once that path is gone is ordinary and worth testing
 * on its own.
 */
export function findUpward(startDir: string, relativePath: string): string | null {
  let dir = startDir
  while (true) {
    const candidate = join(dir, relativePath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Bun single-file embed: `/$bunfs/root/...` (POSIX) or `B:\~BUN\root\...` (Windows) — the
// same detection `@anthropic-ai/claude-agent-sdk/extract`'s own `extractFromBunfs` uses.
const RUNNING_FROM_BUNFS = import.meta.url.includes('$bunfs') || import.meta.url.includes('~BUN')

const BINARY_RELATIVE_PATH =
  `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude` +
  (process.platform === 'win32' ? '.exe' : '')

/**
 * Where to find the Claude Code CLI binary the SDK spawns, when Turnstile's own default
 * resolution needs help — passed as `Options.pathToClaudeCodeExecutable`. Returning `undefined`
 * leaves the SDK to its own built-in resolution (the platform package's ordinary `node_modules`
 * presence), which is all interpreted mode (`bun src/cli/main.ts`) needs.
 *
 * Running from a `bun build --compile` binary, `import.meta.url` resolves to a virtual
 * `/$bunfs/...` path with nothing real beneath it — confirmed directly against a real compiled
 * build: the SDK's own resolution, which assumes a real `node_modules` next to the running
 * file, throws "Native CLI binary for <platform> not found." `process.execPath` is the
 * compiled binary's own real, on-disk location instead (unaffected by the compile step), so
 * searching upward from there finds the same `node_modules` dependency this always needed —
 * the platform package `bun install` put there when it resolved the matching optional
 * dependency for whatever platform is actually running this binary. Computed here at runtime
 * (`process.platform`/`process.arch`) rather than baked in at build time, so the same source
 * resolves correctly on every platform the SDK ships a binary for, without per-platform build
 * steps.
 *
 * (The SDK also ships a `bun build --compile`-specific embedding mechanism —
 * `@anthropic-ai/claude-agent-sdk/extract`'s `extractFromBunfs`, paired with a static
 * `import ... with { type: 'file' }` of the platform package's binary — verified working for
 * a single target platform. Not used here: making it work for every platform the SDK ships a
 * binary for needs a per-platform build step to choose which single static import to bundle,
 * which is out of scope alongside the rest of desktop packaging. The directory-walk below has
 * no such build-time dependency and needs no changes to `bun run build` at all.)
 *
 * Only finds anything while the compiled binary still runs from inside the repo checkout — a
 * real install (a mounted DMG, /Applications) has no `node_modules` above it to walk up to,
 * the same caveat the ACP-era `defaultCommand()` accepted for the same reason. That case is
 * desktop packaging, explicitly out of scope for this migration.
 */
export function resolveExecutable(): string | undefined {
  const override = process.env.TURNSTILE_CLAUDE_CODE_EXECUTABLE
  if (override !== undefined && override.trim() !== '') return override

  if (!RUNNING_FROM_BUNFS) return undefined

  return findUpward(dirname(process.execPath), BINARY_RELATIVE_PATH) ?? undefined
}
