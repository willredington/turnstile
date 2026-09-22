#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { $ } from 'bun'

const repoRoot = new URL('../..', import.meta.url).pathname
const desktopRoot = new URL('..', import.meta.url).pathname

/**
 * Copy to a FRESH file: remove the destination first, never overwrite it in place. macOS caches a
 * binary's code signature by inode, and a new binary written over an old one's inode is SIGKILLed
 * on launch (exit 137) — the "Claude Code process died" failure, found live.
 */
async function freshCopy(from, to) {
  await rm(to, { force: true })
  await copyFile(from, to)
  await chmod(to, 0o755)
}

async function shortHash(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
    .slice(0, 12)
}

console.log('Building turnstile binary...')
await $`bun run build`.cwd(repoRoot)

const sourceBinary = `${repoRoot}/dist/turnstile`
if (!existsSync(sourceBinary)) {
  throw new Error(`Expected ${sourceBinary} after \`bun run build\` — not found`)
}

const hostLine = (await $`rustc -Vv`.text()).split('\n').find((line) => line.startsWith('host: '))
if (!hostLine) throw new Error('Could not determine target triple from `rustc -Vv`')
const targetTriple = hostLine.replace('host: ', '').trim()

const binariesDir = `${desktopRoot}/src-tauri/binaries`
await mkdir(binariesDir, { recursive: true })

const destBinary = `${binariesDir}/turnstile-${targetTriple}`
await freshCopy(sourceBinary, destBinary)

// What the app actually runs is not `binaries/` but the copy Tauri's build step makes next to
// the app executable — and it only makes that copy when Cargo rebuilds, so an app whose Rust
// side hasn't changed kept running an old sidecar indefinitely. Refresh any existing copy here;
// Cargo copying it again afterwards is harmless (it is the same binary).
for (const profile of ['debug', 'release']) {
  const running = `${desktopRoot}/src-tauri/target/${profile}/turnstile`
  if (existsSync(running)) await freshCopy(sourceBinary, running)
}

const commit = (await $`git rev-parse --short HEAD`.cwd(repoRoot).text()).trim()
const dirty = (await $`git status --porcelain`.cwd(repoRoot).text()).trim() !== ''
console.log(
  `Prepared sidecar ${await shortHash(sourceBinary)} from ${commit}${dirty ? ' + uncommitted changes' : ''}: ${destBinary}`,
)

// Bundle the native `claude` binary as a Tauri resource, so a packaged app can find it without
// a repo checkout nearby. The Claude Agent SDK spawns it as a real subprocess (see
// resolveExecutable.ts's TURNSTILE_CLAUDE_CODE_EXECUTABLE override), so bun's `--compile` can't
// inline it the way it does the rest of this app — it has to exist as a real file on disk.
// resolveExecutable()'s own repo-relative directory walk already finds it fine during
// `tauri dev` (and a `tauri build` whose output is still sitting under target/), because the
// binary happens to still be inside the repo checkout then. A real install — a mounted DMG,
// /Applications — has no repo checkout to find. Copied once and cached by existence check
// below, since this rarely changes and re-copying ~300MB on every `tauri dev` start would be
// wasteful; delete desktop/src-tauri/resources to force a refresh after an SDK version bump.
console.log('Bundling native claude CLI...')

const nodeModules = `${repoRoot}/node_modules`
const resourcesDir = `${desktopRoot}/src-tauri/resources/claude-cli`

const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const platformDir = `${nodeModules}/${platformPackage}`
if (!existsSync(platformDir)) {
  throw new Error(
    `Expected ${platformDir} (the native claude CLI for this platform) — not found. Run ` +
      '`bun install` first.',
  )
}

const cliExt = process.platform === 'win32' ? '.exe' : ''
const cliDest = `${resourcesDir}/claude${cliExt}`
if (!existsSync(cliDest)) {
  await mkdir(dirname(cliDest), { recursive: true })
  await freshCopy(`${platformDir}/claude${cliExt}`, cliDest)
}

// Tauri's build step copies resources next to the app executable with a plain `fs::copy` —
// in place, unlike the sidecar, which it removes first. When the app restarts while an old
// sidecar's `claude` is still running from that copy, rewriting its inode gets every later
// launch of it SIGKILLed: a resume that dies on its first prompt, found live. Give it a fresh
// inode now, so Cargo's copy lands on a file nothing has ever executed.
for (const profile of ['debug', 'release']) {
  const running = `${desktopRoot}/src-tauri/target/${profile}/resources/claude-cli/claude${cliExt}`
  if (existsSync(running)) await freshCopy(cliDest, running)
}

console.log(`Bundled native claude CLI at ${resourcesDir}`)
