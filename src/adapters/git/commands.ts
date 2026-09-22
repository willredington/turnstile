/**
 * Git process invocation. Knows nothing about Turnstile — just runs plumbing and returns output.
 */

export type GitResult = { stdout: string; stderr: string; exitCode: number }

export async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export async function gitOrThrow(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await git(cwd, args, env)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}
