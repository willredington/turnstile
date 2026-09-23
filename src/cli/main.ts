#!/usr/bin/env bun
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { annotationsPath } from '../adapters/fs/annotations.ts'
import { configPath, userConfigPath } from '../adapters/fs/config.ts'
import { findingsPath } from '../adapters/fs/findings.ts'
import { hiddenPath } from '../adapters/fs/hidden.ts'
import { DEFAULT_CONFIG, STATE_DIR } from '../core/config.ts'
import { runApp } from './app.ts'

const USAGE = `turnstile — see everything a coding agent changed, and send it notes

  turnstile                    Open the app. This is the normal way to use Turnstile.
  turnstile init                Write .turnstile/config.json.
  turnstile reset               Forget every note, reviewed mark and review.
`

/**
 * What `reset` removes: the notes, the hidden files, the stored reviews, and state files earlier
 * versions of Turnstile wrote that nothing reads any more (review decisions, per-run counters,
 * the advisor's pass log, the per-file review cache).
 */
const RESET_PATHS = (cwd: string): string[] => [
  annotationsPath(cwd),
  hiddenPath(cwd),
  findingsPath(cwd),
  join(cwd, STATE_DIR, 'reviewed.json'),
  join(cwd, STATE_DIR, 'state.json'),
  join(cwd, STATE_DIR, 'passed.jsonl'),
  join(cwd, STATE_DIR, 'cache'),
]

/**
 * Add the state directory to .gitignore if it isn't covered already.
 *
 * Snapshots exclude `.turnstile/` regardless, so this is not correctness — it keeps
 * Turnstile's config and notes out of the user's own commits and `git status`.
 */
async function ensureGitignored(cwd: string): Promise<void> {
  const path = join(cwd, '.gitignore')
  const file = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : ''

  const alreadyListed = existing
    .split('\n')
    .some((line) => line.trim() === STATE_DIR || line.trim() === `${STATE_DIR}/`)
  if (alreadyListed) return

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await Bun.write(path, `${existing}${separator}${STATE_DIR}/\n`)
  process.stdout.write(`Added ${STATE_DIR}/ to ${path}\n`)
}

async function cmdInit(cwd: string): Promise<number> {
  const path = configPath(cwd)
  if (await Bun.file(path).exists()) {
    process.stdout.write(`Config already exists at ${path} — leaving it alone.\n\n`)
  } else {
    await Bun.write(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    process.stdout.write(`Wrote ${path}\n\n`)
  }

  await ensureGitignored(cwd)

  process.stdout.write(
    `Run \`turnstile\` in this directory to open the app.\n\n` +
      `A personal config at ${userConfigPath()} is also read, if present — this repo's own ` +
      'fields still take priority over it.\n',
  )
  return 0
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2)
  const cwd = process.cwd()

  switch (command) {
    case undefined:
    case 'app':
      // Never returns: the app runs until interrupted.
      await runApp()
      return 0

    case 'init':
      return await cmdInit(cwd)

    case 'reset': {
      for (const path of RESET_PATHS(cwd)) await rm(path, { recursive: true, force: true })
      process.stdout.write('Forgot every note, reviewed mark and review.\n')
      return 0
    }

    default:
      process.stdout.write(USAGE)
      return command === '--help' || command === '-h' ? 0 : 1
  }
}

process.exit(await main())
