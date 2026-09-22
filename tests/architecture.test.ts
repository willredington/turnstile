import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * The boundary guard.
 *
 * Layering that lives only in a README rots on the first deadline. This walks the real
 * import graph and fails the build when a dependency points the wrong way, which is what
 * makes "clear boundaries" a property of the codebase rather than an intention.
 *
 * The rule is a strict downward stack:
 *
 *   cli       → may reach anything (it is the composition root)
 *   adapters  → core only, and never a sibling adapter
 *   app       → core only (no adapter may be named)
 *   core      → nothing but itself
 */

const SRC = resolve(import.meta.dir, '../src')

type Layer = 'core' | 'app' | 'adapters' | 'cli'

/** What each layer is allowed to import from, beyond its own files. */
const ALLOWED: Record<Layer, Layer[]> = {
  core: [],
  app: ['core'],
  adapters: ['core'],
  cli: ['core', 'app', 'adapters'],
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return /\.tsx?$/.test(entry.name) ? [full] : []
    }),
  )
  return files.flat()
}

function layerOf(file: string): Layer | null {
  const [top] = relative(SRC, file).split('/')
  return top === 'core' || top === 'app' || top === 'adapters' || top === 'cli' ? top : null
}

/** Relative imports only; package imports (react, zod, node:*) are not layered. */
function relativeImports(source: string): string[] {
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1] as string)
}

type Edge = { from: string; to: string; fromLayer: Layer; toLayer: Layer }

async function importGraph(): Promise<Edge[]> {
  const files = await sourceFiles(SRC)
  const edges: Edge[] = []

  for (const file of files) {
    const fromLayer = layerOf(file)
    if (fromLayer === null) continue

    const source = await readFile(file, 'utf-8')
    for (const specifier of relativeImports(source)) {
      const target = resolve(dirname(file), specifier)
      const toLayer = layerOf(target)
      if (toLayer === null) continue
      edges.push({
        from: relative(SRC, file),
        to: relative(SRC, target),
        fromLayer,
        toLayer,
      })
    }
  }
  return edges
}

describe('layer boundaries', () => {
  test('every source file belongs to a declared layer', async () => {
    const files = await sourceFiles(SRC)
    const orphans = files.filter((file) => layerOf(file) === null).map((f) => relative(SRC, f))
    expect(orphans).toEqual([])
  })

  test('the graph is not empty, so a passing run means something', async () => {
    expect((await importGraph()).length).toBeGreaterThan(10)
  })

  for (const [layer, allowed] of Object.entries(ALLOWED) as [Layer, Layer[]][]) {
    test(`${layer} imports only from ${allowed.length > 0 ? allowed.join(', ') : 'itself'}`, async () => {
      const violations = (await importGraph())
        .filter((edge) => edge.fromLayer === layer)
        .filter((edge) => edge.toLayer !== layer && !allowed.includes(edge.toLayer))
        .map((edge) => `${edge.from} → ${edge.to}`)

      expect(violations).toEqual([])
    })
  }

  /**
   * The inversion that started the rework: pure policy reaching into infrastructure for
   * the types it operates on.
   */
  test('core never reaches into an adapter', async () => {
    const leaks = (await importGraph())
      .filter((edge) => edge.fromLayer === 'core' && edge.toLayer !== 'core')
      .map((edge) => `${edge.from} → ${edge.to}`)
    expect(leaks).toEqual([])
  })

  test('the pipeline never names a concrete adapter', async () => {
    const leaks = (await importGraph())
      .filter((edge) => edge.fromLayer === 'app' && edge.toLayer === 'adapters')
      .map((edge) => `${edge.from} → ${edge.to}`)
    expect(leaks).toEqual([])
  })

  /** Adapters are peers. One reaching for another re-tangles what the split undid. */
  test('no adapter imports a sibling adapter', async () => {
    const familyOf = (path: string): string => path.split('/')[1] ?? ''
    const leaks = (await importGraph())
      .filter((edge) => edge.fromLayer === 'adapters' && edge.toLayer === 'adapters')
      .filter((edge) => familyOf(edge.from) !== familyOf(edge.to))
      .map((edge) => `${edge.from} → ${edge.to}`)
    expect(leaks).toEqual([])
  })

  /**
   * The UI shares the domain vocabulary with the server, which is the point of having
   * one — but it must not reach into server-side adapter code.
   */
  test('the browser bundle imports only core', async () => {
    const leaks = (await importGraph())
      .filter((edge) => edge.from.startsWith('adapters/web/ui/'))
      .filter((edge) => edge.toLayer !== 'core' && !edge.to.startsWith('adapters/web/ui/'))
      .map((edge) => `${edge.from} → ${edge.to}`)
    expect(leaks).toEqual([])
  })
})

describe('core stays pure', () => {
  /** Core is meant to be callable in a test with no filesystem, network, or process. */
  test('no I/O primitives appear in core', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles(join(SRC, 'core'))) {
      const source = await readFile(file, 'utf-8')
      for (const pattern of [/\bBun\.(file|write|spawn|serve|\$)/, /\bfetch\(/, /from 'node:fs/]) {
        if (pattern.test(source)) offenders.push(`${relative(SRC, file)}: ${pattern.source}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
