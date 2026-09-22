import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  mergeConfigLayers,
  STATE_DIR,
  type TurnstileConfig,
} from '../../core/config.ts'

const CONFIG_FILE = 'config.json'

export function configPath(cwd: string): string {
  return join(cwd, STATE_DIR, CONFIG_FILE)
}

/** The personal, cross-repo config: the same relative layout as the repo's own, at $HOME. */
export function userConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, STATE_DIR, CONFIG_FILE)
}

/** Raw JSON at `path`, or `undefined` if the file does not exist. Throws on invalid JSON. */
async function readRawConfig(path: string): Promise<unknown> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  try {
    return await file.json()
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause })
  }
}

/**
 * Load config, layering the repo's `.turnstile/config.json` over the user-level
 * `~/.turnstile/config.json`, falling back to schema defaults for whatever neither sets.
 *
 * A malformed config throws rather than silently defaulting. The gate is a
 * security-adjacent control: quietly reviewing under settings the user did not write —
 * a neverReview list that failed to parse, say — is worse than refusing to start.
 */
export async function loadConfig(
  cwd: string,
  homeDir: string = homedir(),
): Promise<TurnstileConfig> {
  const repoPath = configPath(cwd)
  const userPath = userConfigPath(homeDir)

  const [userRaw, repoRaw] = await Promise.all([readRawConfig(userPath), readRawConfig(repoPath)])

  // DEFAULT_CONFIG rather than a literal: a second copy of the defaults is a second thing
  // to remember when they change, and it silently disagreed with the first once already.
  if (userRaw === undefined && repoRaw === undefined) return DEFAULT_CONFIG

  const merged = mergeConfigLayers(userRaw ?? {}, repoRaw ?? {})

  const result = ConfigSchema.safeParse(merged)
  if (!result.success) {
    const label =
      userRaw === undefined
        ? repoPath
        : repoRaw === undefined
          ? userPath
          : `${userPath} + ${repoPath}`
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid config at ${label}:\n${detail}`)
  }
  return result.data
}
