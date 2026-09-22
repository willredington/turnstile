/** Fire-and-forget POST to Turnstile's own server. Every pane that can act on the session shares
 *  this rather than each rolling its own — the failure mode (a dropped connection) is not
 *  worth surfacing per call site: the socket state driving the rest of the UI already shows
 *  when Turnstile is unreachable. */
export async function post(path: string, body: unknown): Promise<void> {
  await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

/**
 * A POST whose outcome the caller has to act on.
 *
 * `post` above is deliberately fire-and-forget, which is right for everything that can simply
 * be retried by clicking again. It is wrong for saving a file: the editor clears its
 * unsaved-changes marker when a save resolves, so a refusal that resolved quietly would tell
 * the reader their work is on disk when it is not. Throws with whatever the server said.
 */
export async function postOrThrow(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.ok) return
  const detail = (await response.json().catch(() => null)) as { error?: unknown } | null
  throw new Error(
    typeof detail?.error === 'string' ? detail.error : `the server refused it (${response.status})`,
  )
}

/**
 * A POST whose *answer* the caller needs, not just its outcome.
 *
 * The other two return `void`, which is right while the server's reply is an acknowledgement
 * and the real answer arrives over the socket. Asking a question is the exception: there is no
 * session state for the answer to come back through, so the response body is the whole point.
 * Refusals throw the same way `postOrThrow` refuses, since "no API key" has to reach the card
 * that is showing a spinner.
 */
export async function postForJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const detail = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (response.ok && detail !== null) return detail
  throw new Error(
    typeof detail?.error === 'string' ? detail.error : `the server refused it (${response.status})`,
  )
}
