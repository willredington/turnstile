/**
 * The reviewer's latest call, in a few words, for the review progress bar — "reading
 * src/cli.py", "searching for SdkAnalyst". Paths are shown relative to the repository root.
 */

const MAX_LENGTH = 80

const brief = (text: string): string => {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line
}

const relativeTo = (root: string, path: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

export function describeReviewCall(root: string, toolName: string, input: unknown): string {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  const path = text(fields.file_path) ?? text(fields.path)
  switch (toolName) {
    case 'Read':
      return path === null ? 'reading' : `reading ${brief(relativeTo(root, path))}`
    case 'Grep': {
      const pattern = text(fields.pattern)
      return pattern === null ? 'searching' : `searching for ${brief(pattern)}`
    }
    case 'Glob': {
      const pattern = text(fields.pattern)
      return pattern === null ? 'listing files' : `listing ${brief(pattern)}`
    }
    case 'Bash': {
      const said = text(fields.description) ?? text(fields.command)
      return said === null ? 'running a command' : `running ${brief(said)}`
    }
    case 'Skill': {
      const skill = text(fields.skill)
      return skill === null ? 'using a skill' : `using the ${brief(skill)} skill`
    }
    default:
      return `using ${toolName.replace(/^mcp__[^_]+__/, '')}`
  }
}
