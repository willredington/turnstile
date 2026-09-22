import { describe, expect, test } from 'bun:test'
import type { RiskBarConfig } from '../../src/core/config.ts'
import {
  extensionOf,
  isCommentOnly,
  isDocPath,
  isSpecPath,
  isWhitespaceOnly,
  matchesGlob,
  skipReason,
  skipReasons,
} from '../../src/core/riskbar.ts'
import type { FileDelta } from '../../src/core/types.ts'

// Only the globs: the classifier is a pure function over paths and lines.
const OPEN: Pick<RiskBarConfig, 'alwaysReview' | 'neverReview' | 'specPaths'> = {
  alwaysReview: [],
  neverReview: [],
  specPaths: [],
}

function delta(overrides: Partial<FileDelta> & { path: string }): FileDelta {
  return {
    status: 'Modified',
    pureRename: false,
    binary: false,
    hunks: [{ startLine: 1, endLine: 1 }],
    addedLines: [],
    removedLines: [],
    ...overrides,
  }
}

describe('extensionOf', () => {
  const cases: [string, string][] = [
    ['src/app.ts', 'ts'],
    ['src/App.TSX', 'tsx'],
    ['Makefile', ''],
    ['.gitignore', ''],
    ['a/b.c/d', ''],
    ['archive.tar.gz', 'gz'],
  ]
  for (const [path, expected] of cases) {
    test(`${path} -> "${expected}"`, () => {
      expect(extensionOf(path)).toBe(expected)
    })
  }
})

describe('isDocPath', () => {
  const docs = ['README.md', 'notes.txt', 'docs/guide.ts', 'doc/x.py', 'LICENSE', 'CHANGELOG']
  for (const path of docs) {
    test(`${path} is documentation`, () => {
      expect(isDocPath(path)).toBe(true)
    })
  }

  const code = ['src/app.ts', 'documentation.ts', 'src/docs.ts', 'mydocs/a.ts']
  for (const path of code) {
    test(`${path} is not documentation`, () => {
      expect(isDocPath(path)).toBe(false)
    })
  }
})

describe('isWhitespaceOnly', () => {
  test('detects a reindent', () => {
    expect(
      isWhitespaceOnly(
        delta({ path: 'a.ts', removedLines: ['  const x = 1'], addedLines: ['    const x = 1'] }),
      ),
    ).toBe(true)
  })

  test('detects a reflow across lines', () => {
    expect(
      isWhitespaceOnly(
        delta({ path: 'a.ts', removedLines: ['foo(a, b)'], addedLines: ['foo(', '  a,', '  b)'] }),
      ),
    ).toBe(true)
  })

  test('rejects a real edit', () => {
    expect(
      isWhitespaceOnly(delta({ path: 'a.ts', removedLines: ['x = 1'], addedLines: ['x = 2'] })),
    ).toBe(false)
  })

  test('rejects a pure addition', () => {
    expect(isWhitespaceOnly(delta({ path: 'a.ts', addedLines: ['x = 1'] }))).toBe(false)
  })

  test('rejects a pure deletion', () => {
    expect(isWhitespaceOnly(delta({ path: 'a.ts', removedLines: ['x = 1'] }))).toBe(false)
  })
})

describe('isCommentOnly', () => {
  test('accepts line comments', () => {
    expect(isCommentOnly(delta({ path: 'a.ts', addedLines: ['// explain', '// more'] }))).toBe(true)
  })

  test('accepts a hash-comment language', () => {
    expect(isCommentOnly(delta({ path: 'a.py', addedLines: ['# explain'] }))).toBe(true)
  })

  test('accepts a JSDoc block', () => {
    expect(
      isCommentOnly(delta({ path: 'a.ts', addedLines: ['/**', ' * why this exists', ' */'] })),
    ).toBe(true)
  })

  /**
   * The dangerous direction: mistaking code for a comment lets a real change pass
   * silently. A C pointer dereference starts with `*` but is not a JSDoc continuation.
   */
  test('does not mistake a pointer dereference for a JSDoc continuation', () => {
    expect(isCommentOnly(delta({ path: 'a.c', addedLines: ['*ptr = 5;'] }))).toBe(false)
  })

  test('rejects a mix of comment and code', () => {
    expect(isCommentOnly(delta({ path: 'a.ts', addedLines: ['// note', 'const x = 1'] }))).toBe(
      false,
    )
  })

  test('rejects an unknown extension rather than guessing', () => {
    expect(isCommentOnly(delta({ path: 'a.unknownext', addedLines: ['// looks like one'] }))).toBe(
      false,
    )
  })

  test('rejects an empty change', () => {
    expect(isCommentOnly(delta({ path: 'a.ts' }))).toBe(false)
  })
})

describe('matchesGlob', () => {
  const cases: [string, string, boolean][] = [
    ['src/app.ts', 'src/*.ts', true],
    ['src/deep/app.ts', 'src/*.ts', false],
    ['src/deep/app.ts', 'src/**/*.ts', true],
    ['src/app.ts', 'src/**/*.ts', true],
    ['package.json', 'package.json', true],
    ['a/package.json', 'package.json', false],
    ['src/app.ts', '**/*.ts', true],
    ['migrations/001.sql', 'migrations/**', true],
  ]
  for (const [path, pattern, expected] of cases) {
    test(`${path} vs ${pattern} -> ${expected}`, () => {
      expect(matchesGlob(path, pattern)).toBe(expected)
    })
  }
})

/**
 * What gets a risk check and what does not, file by file. The skip reason is what the reader
 * sees in place of an analysis, so it has to name why.
 */
describe('which files are worth a risk check', () => {
  test('a logic change is', () => {
    expect(
      skipReason(
        delta({ path: 'src/api.ts', removedLines: ['return x'], addedLines: ['return await x'] }),
        OPEN,
      ),
    ).toBeNull()
  })

  test('a new file is', () => {
    expect(
      skipReason(
        delta({ path: 'src/new.ts', status: 'Created', addedLines: ['export const x = 1'] }),
        OPEN,
      ),
    ).toBeNull()
  })

  test('a dependency change is', () => {
    expect(
      skipReason(
        delta({ path: 'package.json', removedLines: ['"a": "1"'], addedLines: ['"a": "2"'] }),
        OPEN,
      ),
    ).toBeNull()
  })

  test('a changed binary it cannot inspect is', () => {
    expect(skipReason(delta({ path: 'bin/tool', binary: true }), OPEN)).toBeNull()
  })

  /**
   * The failure mode that gets review tools disabled: spending attention on changes that
   * cannot matter.
   */
  test('documentation is not', () => {
    expect(skipReason(delta({ path: 'README.md', addedLines: ['new prose'] }), OPEN)).toContain(
      'documentation',
    )
  })

  test('formatting is not', () => {
    expect(
      skipReason(delta({ path: 'src/a.ts', removedLines: ['x=1'], addedLines: ['x = 1'] }), OPEN),
    ).toContain('whitespace')
  })

  test('comments are not', () => {
    expect(skipReason(delta({ path: 'src/a.ts', addedLines: ['// clarify'] }), OPEN)).toContain(
      'comments only',
    )
  })

  test('a mechanical rename is not', () => {
    expect(
      skipReason(delta({ path: 'src/b.ts', previousPath: 'src/a.ts', pureRename: true }), OPEN),
    ).toContain('rename')
  })

  /** A reason names its file, so a skipped file is auditable rather than silent. */
  test('the reason names the file', () => {
    expect(skipReason(delta({ path: 'README.md', addedLines: ['prose'] }), OPEN)).toContain(
      'README.md',
    )
  })

  describe('escape hatches', () => {
    test('neverReview skips a file that would otherwise be checked', () => {
      expect(
        skipReason(
          delta({ path: 'generated/api.ts', removedLines: ['x = 1'], addedLines: ['x = 2'] }),
          { alwaysReview: [], neverReview: ['generated/**'], specPaths: [] },
        ),
      ).not.toBeNull()
    })

    test('alwaysReview forces a check on a file the heuristic would skip', () => {
      expect(
        skipReason(delta({ path: 'docs/spec.md', addedLines: ['prose'] }), {
          alwaysReview: ['docs/**'],
          neverReview: [],
          specPaths: [],
        }),
      ).toBeNull()
    })

    test('alwaysReview outranks neverReview on the same path', () => {
      expect(
        skipReason(delta({ path: 'src/a.ts', addedLines: ['// note'] }), {
          alwaysReview: ['src/**'],
          neverReview: ['src/**'],
          specPaths: [],
        }),
      ).toBeNull()
    })

    test('specPaths forces a check on a markdown file the doc heuristic would skip', () => {
      expect(
        skipReason(delta({ path: 'docs/specs/plan.md', addedLines: ['prose'] }), {
          alwaysReview: [],
          neverReview: [],
          specPaths: ['docs/specs/**/*.md'],
        }),
      ).toBeNull()
    })

    test('specPaths outranks neverReview on the same path', () => {
      expect(
        skipReason(delta({ path: 'docs/specs/plan.md', addedLines: ['prose'] }), {
          alwaysReview: [],
          neverReview: ['docs/**'],
          specPaths: ['docs/specs/**/*.md'],
        }),
      ).toBeNull()
    })
  })
})

describe('isSpecPath', () => {
  test('matches a configured glob', () => {
    expect(isSpecPath('docs/specs/2026-plan.md', ['docs/specs/**/*.md'])).toBe(true)
  })

  test('does not match outside the glob', () => {
    expect(isSpecPath('docs/guide.md', ['docs/specs/**/*.md'])).toBe(false)
  })

  test('is false when no patterns are configured', () => {
    expect(isSpecPath('docs/specs/plan.md', [])).toBe(false)
  })
})

describe('isWhitespaceOnly in indent-significant languages', () => {
  /**
   * Reindenting Python moves a statement in or out of a block — a behavior change that
   * happens to be made entirely of whitespace. Treating it as formatting would let a
   * real logic change skip its risk check silently.
   */
  test('checks a Python reindent', () => {
    expect(
      skipReason(
        delta({
          path: 'app.py',
          removedLines: ['    do_thing()'],
          addedLines: ['do_thing()'],
        }),
        OPEN,
      ),
    ).toBeNull()
  })

  test('does not treat a YAML reindent as formatting', () => {
    expect(
      isWhitespaceOnly(
        delta({ path: 'c.yml', removedLines: ['  key: value'], addedLines: ['    key: value'] }),
      ),
    ).toBe(false)
  })

  test('still passes trailing-whitespace cleanup in Python', () => {
    expect(
      isWhitespaceOnly(
        delta({
          path: 'app.py',
          removedLines: ['    do_thing()   '],
          addedLines: ['    do_thing()'],
        }),
      ),
    ).toBe(true)
  })
})

/**
 * Generated paths.
 *
 * The motivating complaint was lockfiles: a 4,000-line resolution churn wrapped around one
 * real dependency line. These are skipped without a model, because they are cases we can name in
 * advance — and a rule you can name is always better than asking something to guess.
 */
describe('generated and vendored paths', () => {
  const substantive = (path: string): FileDelta => ({
    path,
    status: 'Modified',
    pureRename: false,
    binary: false,
    hunks: [{ startLine: 1, endLine: 2 }],
    addedLines: ['  "left-pad": "1.3.0",'],
    removedLines: ['  "left-pad": "1.2.0",'],
  })

  const bar = { alwaysReview: [], neverReview: [], specPaths: [] }

  for (const lockfile of [
    'bun.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
    'go.sum',
    'apps/web/package-lock.json',
  ]) {
    test(`${lockfile} is skipped`, () => {
      expect(skipReason(substantive(lockfile), bar)).toContain('generated or vendored')
    })
  }

  test('vendored and build output are skipped', () => {
    for (const path of ['vendor/thing.go', 'node_modules/x/index.js', 'app/dist/bundle.js']) {
      expect(skipReason(substantive(path), bar)).not.toBeNull()
    }
  })

  test('snapshots are skipped', () => {
    expect(skipReason(substantive('tests/__snapshots__/x.snap'), bar)).not.toBeNull()
  })

  /**
   * The reason skipping a lockfile is safe: the manifest that moved it is still checked on
   * its own, so the dependency change is never actually hidden.
   */
  test('the manifest beside a lockfile is still checked', () => {
    const skips = skipReasons([substantive('bun.lock'), substantive('package.json')], bar)
    expect(skips.has('bun.lock')).toBe(true)
    expect(skips.has('package.json')).toBe(false)
  })

  test('alwaysReview outranks the built-in list', () => {
    expect(
      skipReason(substantive('bun.lock'), {
        alwaysReview: ['**/bun.lock'],
        neverReview: [],
        specPaths: [],
      }),
    ).toBeNull()
  })

  /** A user adding one glob must not lose every built-in. */
  test('a user neverReview extends rather than replaces the built-ins', () => {
    const bar = { alwaysReview: [], neverReview: ['generated/**'], specPaths: [] }
    expect(skipReason(substantive('generated/api.ts'), bar)).not.toBeNull()
    expect(skipReason(substantive('bun.lock'), bar)).not.toBeNull()
  })

  test('an ordinary source file is untouched by any of this', () => {
    expect(skipReason(substantive('src/orders.ts'), bar)).toBeNull()
  })
})

/**
 * The judgement the board and the background pass both apply. It must be one rule read
 * twice — a file skipped on the board and then analysed in the background would cost money
 * precisely when nobody wanted it spent.
 */
describe('skipReason', () => {
  const lock = delta({
    path: 'bun.lock',
    addedLines: ['  "left-pad": "1.3.0",'],
    removedLines: ['  "left-pad": "1.2.0",'],
  })
  const code = delta({
    path: 'src/orders.ts',
    addedLines: ['const cap = 0.5'],
    removedLines: ['const cap = 1'],
  })

  test('names why a lockfile is not worth analysing', () => {
    expect(skipReason(lock, OPEN)).toContain('generated or vendored')
  })

  test('says nothing about a source file', () => {
    expect(skipReason(code, OPEN)).toBeNull()
  })

  test('honours a user neverReview glob', () => {
    expect(
      skipReason(code, { alwaysReview: [], neverReview: ['src/**'], specPaths: [] }),
    ).toContain('neverReview')
  })

  /** The user overruling a heuristic buys the analysis back. */
  test('alwaysReview outranks every skip', () => {
    expect(
      skipReason(lock, { alwaysReview: ['**/bun.lock'], neverReview: [], specPaths: [] }),
    ).toBeNull()
  })

  test('specPaths outranks the documentation skip', () => {
    const spec = delta({ path: 'docs/specs/plan.md', addedLines: ['prose'] })
    expect(
      skipReason(spec, { alwaysReview: [], neverReview: [], specPaths: ['docs/specs/**/*.md'] }),
    ).toBeNull()
  })

  test('skipReasons keys the whole batch by path, skipped files only', () => {
    const skips = skipReasons([lock, code], OPEN)
    expect([...skips.keys()]).toEqual(['bun.lock'])
  })
})
