import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

/**
 * Balances an odd count of fences by appending a synthetic closing one, so a streamed
 * assistant entry mid-code-block renders as an in-progress block instead of flickering
 * between literal backticks and a real one as it grows token by token. Never mutates the
 * stored entry text — this only shapes what one render hands the parser.
 */
function withBalancedFences(text: string): string {
  const fences = text.match(/```/g)?.length ?? 0
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/** Agent prose, rendered as markdown rather than the literal `**`/backtick characters a
 *  `<pre>` block would show. Parsed with `marked` and sanitized with `dompurify` before it
 *  ever reaches the DOM. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => {
    const parsed = marked.parse(withBalancedFences(text), { async: false }) as string
    return DOMPurify.sanitize(parsed)
  }, [text])

  // biome-ignore lint/security/noDangerouslySetInnerHtml: html is sanitized above via DOMPurify
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
}
