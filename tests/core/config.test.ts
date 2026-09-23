import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, userConfigPath } from '../../src/adapters/fs/config.ts'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/core/config.ts'

let dir: string
// A fake $HOME, isolated from whatever the machine actually running these tests has under its
// own ~/.turnstile/config.json — otherwise a developer's own personal config would start
// leaking into every test the day they created one.
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turnstile-config-'))
  home = await mkdtemp(join(tmpdir(), 'turnstile-home-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('loadConfig', () => {
  test('falls back to defaults when no config exists', async () => {
    expect(await loadConfig(dir, home)).toEqual(DEFAULT_CONFIG)
  })

  /**
   * Not which model, but that there is exactly one place that says so. The fallback used to
   * carry its own literal, which drifted from DEFAULT_CONFIG the first time the default was
   * changed — and the only symptom was an unrelated-looking test failure.
   */
  test('the no-config fallback is the declared default, not a second copy of it', async () => {
    expect((await loadConfig(dir, home)).ask.model.models).toEqual(DEFAULT_CONFIG.ask.model.models)
  })

  /** Same claim on the same delta twice, or the human cannot tell a new challenge
   * from a resampled one. */
  test('defaults to a deterministic temperature', async () => {
    expect(DEFAULT_CONFIG.ask.model.temperature).toBe(0)
  })

  test('reads a user config', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({
        review: { model: 'opus' },
        openrouter: { apiKeyEnv: 'MY_KEY' },
      }),
    )
    const config = await loadConfig(dir, home)
    expect(config.review.model).toBe('opus')
    expect(config.openrouter.apiKeyEnv).toBe('MY_KEY')
  })

  /**
   * The review window and the advisor went away with the review cycle. A config written
   * before then must still load — refusing it would stop a project over a setting that no
   * longer means anything.
   */
  test('ignores settings from before the review cycle was removed', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({
        reviewTimeoutMs: 60000,
        riskBar: { advisor: { enabled: true } },
      }),
    )
    const config = await loadConfig(dir, home)
    expect(config).not.toHaveProperty('reviewTimeoutMs')
    expect(config.riskBar).not.toHaveProperty('advisor')
  })

  /** The same for the brief experiment with TypeSafe rule checks, which the reviewer replaced. */
  test('ignores settings from the TypeSafe rule checks', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({
        typesafe: { model: 'jev-latest' },
        review: { threshold: 0.5 },
      }),
    )
    const config = await loadConfig(dir, home)
    expect(config).not.toHaveProperty('typesafe')
    expect(config.review).not.toHaveProperty('threshold')
  })

  test('fills unspecified sections with defaults', async () => {
    await Bun.write(join(dir, '.turnstile/config.json'), JSON.stringify({}))
    const config = await loadConfig(dir, home)
    expect(config.riskBar).toEqual({
      alwaysReview: [],
      neverReview: [],
      specPaths: [],
    })
    expect(config.openrouter.apiKeyEnv).toBe('OPENROUTER_API_KEY')
    expect(config.toolPermissions).toEqual({ denyPatterns: [] })
  })

  /**
   * A broken config means we do not know the user's review policy. Throwing is correct:
   * reviewing under settings the user did not write is undetectable after the fact.
   */
  test('throws on malformed JSON rather than silently defaulting', async () => {
    await Bun.write(join(dir, '.turnstile/config.json'), '{ not json')
    await expect(loadConfig(dir, home)).rejects.toThrow('not valid JSON')
  })

  test('throws with a path-prefixed detail on a schema violation', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ ask: { model: { models: [] } } }),
    )
    await expect(loadConfig(dir, home)).rejects.toThrow('ask.model.models')
  })

  test('rejects an empty API key variable name', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ openrouter: { apiKeyEnv: '' } }),
    )
    await expect(loadConfig(dir, home)).rejects.toThrow('openrouter.apiKeyEnv')
  })

  test('rejects an invalid deny-pattern regex', async () => {
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ toolPermissions: { denyPatterns: ['('] } }),
    )
    await expect(loadConfig(dir, home)).rejects.toThrow('toolPermissions.denyPatterns')
  })
})

describe('user-level config', () => {
  test('is read when the repo has none', async () => {
    await Bun.write(
      join(home, '.turnstile/config.json'),
      JSON.stringify({ review: { model: 'personal-default' } }),
    )
    const config = await loadConfig(dir, home)
    expect(config.review.model).toBe('personal-default')
  })

  /**
   * The repo's config.json is the more specific layer: a field it sets should win over the
   * same field in the personal config, without discarding the personal fields it left alone.
   */
  test('a field the repo sets overrides the same field from the user config', async () => {
    await Bun.write(
      join(home, '.turnstile/config.json'),
      JSON.stringify({
        review: { model: 'personal-model' },
        openrouter: { apiKeyEnv: 'PERSONAL_KEY' },
      }),
    )
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ review: { model: 'repo-model' } }),
    )
    const config = await loadConfig(dir, home)
    expect(config.review.model).toBe('repo-model')
    expect(config.openrouter.apiKeyEnv).toBe('PERSONAL_KEY')
  })

  /**
   * Arrays are replaced wholesale, not concatenated — a repo's own riskBar globs should not
   * silently pick up entries from a personal config the repo's author never saw.
   */
  test('an array the repo sets replaces the user config array rather than concatenating', async () => {
    await Bun.write(
      join(home, '.turnstile/config.json'),
      JSON.stringify({ riskBar: { neverReview: ['personal/**'] } }),
    )
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ riskBar: { neverReview: ['repo/**'] } }),
    )
    const config = await loadConfig(dir, home)
    expect(config.riskBar.neverReview).toEqual(['repo/**'])
  })

  test('toolPermissions.denyPatterns replaces rather than concatenates too', async () => {
    await Bun.write(
      join(home, '.turnstile/config.json'),
      JSON.stringify({
        toolPermissions: { denyPatterns: ['^personal$'] },
      }),
    )
    await Bun.write(
      join(dir, '.turnstile/config.json'),
      JSON.stringify({ toolPermissions: { denyPatterns: ['^repo$'] } }),
    )
    const config = await loadConfig(dir, home)
    expect(config.toolPermissions.denyPatterns).toEqual(['^repo$'])
  })

  test('throws naming the user config path when only it is malformed', async () => {
    await Bun.write(join(home, '.turnstile/config.json'), '{ not json')
    await expect(loadConfig(dir, home)).rejects.toThrow(userConfigPath(home))
  })
})

describe('review', () => {
  test('runs on the claude CLI’s own default model unless one is named', () => {
    expect(DEFAULT_CONFIG.review.model).toBeUndefined()
  })

  test('has a whole-review budget by default', () => {
    expect(DEFAULT_CONFIG.review).toMatchObject({ maxTurns: 60, timeoutMs: 600_000 })
  })

  /**
   * The review used to run on an OpenRouter model against YAML rules. A config written for it
   * must still load — refusing it would stop a project over settings that no longer mean
   * anything.
   */
  test('ignores settings from the rule-based reviewer', () => {
    const parsed = ConfigSchema.parse({
      model: { models: ['meta/muse-spark-1.1'] },
      review: { maxSteps: 16, concurrency: 3, rulesDir: '~/rules', timeoutMs: 90_000 },
    })
    expect(parsed.review).toEqual({ maxTurns: 60, timeoutMs: 90_000 })
    expect('model' in parsed).toBe(false)
  })
})

describe('specPaths', () => {
  test('defaults to empty', () => {
    expect(DEFAULT_CONFIG.riskBar.specPaths).toEqual([])
  })

  test('accepts custom glob patterns', () => {
    const parsed = ConfigSchema.parse({
      riskBar: { specPaths: ['docs/specs/**/*.md'] },
    })
    expect(parsed.riskBar.specPaths).toEqual(['docs/specs/**/*.md'])
  })
})

describe('toolPermissions', () => {
  test('defaults to no deny patterns', () => {
    expect(DEFAULT_CONFIG.toolPermissions.denyPatterns).toEqual([])
  })

  test('accepts valid regex strings', () => {
    const parsed = ConfigSchema.parse({
      toolPermissions: { denyPatterns: ['^WebFetch$', 'rm -rf'] },
    })
    expect(parsed.toolPermissions.denyPatterns).toEqual(['^WebFetch$', 'rm -rf'])
  })

  test('rejects an invalid regex string', () => {
    expect(() =>
      ConfigSchema.parse({
        toolPermissions: { denyPatterns: ['('] },
      }),
    ).toThrow()
  })
})
