/**
 * Where the agent's own plan file is allowed to land.
 *
 * Claude Code writes each plan to a file of its own under a single directory, and tells the
 * model the path. Turnstile disallows `Edit`/`Write` outright and scopes its own write tool to
 * the repository, so that file has no sanctioned route — the model reaches for a shell redirect
 * instead, which plan mode now stops and asks about. One prompt per plan, for a file outside the
 * repository that the harness keeps for itself.
 *
 * A tool of its own answers that, and the safety is structural rather than textual: **the
 * destination is built here, not taken from the model.** Everything but the filename is
 * discarded, so there is no path to traverse out of and nothing to parse — which is exactly
 * what makes this a better answer than teaching the shell gate to recognise a redirect target.
 */

/** Filenames a plan may have: one segment, ordinary characters, markdown. */
const PLAN_FILE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\.md$/

/**
 * The filename to write, taken from whatever the model asked for, or null if there isn't a
 * usable one.
 *
 * Only the last segment survives: `../../.ssh/authorized_keys` and
 * `/Users/x/.claude/plans/my-plan.md` both reduce to their basename, and a basename cannot
 * climb anywhere. `..` fails the pattern outright, having no extension to pass it.
 */
export function planFileName(requested: string): string | null {
  const name = requested.split(/[\\/]/).pop() ?? ''
  return PLAN_FILE.test(name) ? name : null
}
