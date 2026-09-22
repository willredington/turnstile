import { describe, expect, test } from 'bun:test'
import { pathToLanguage } from '../../src/core/language.ts'

describe('pathToLanguage', () => {
  test.each([
    ['src/foo.ts', 'typescript'],
    ['src/foo.mts', 'typescript'],
    ['src/foo.cts', 'typescript'],
    ['src/App.tsx', 'tsx'],
    ['src/foo.js', 'javascript'],
    ['src/foo.mjs', 'javascript'],
    ['src/foo.cjs', 'javascript'],
    ['src/App.jsx', 'jsx'],
    ['src/main.rs', 'rust'],
    ['scripts/build.py', 'python'],
    ['scripts/build.pyw', 'python'],
    ['cmd/main.go', 'go'],
    ['package.json', 'json'],
    ['tsconfig.jsonc', 'json'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['.github/workflows/ci.yaml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['src/styles.css', 'css'],
    ['index.html', 'html'],
    ['page.htm', 'html'],
    ['README.md', 'markdown'],
    ['NOTES.markdown', 'markdown'],
    ['scripts/deploy.sh', 'bash'],
    ['scripts/deploy.bash', 'bash'],
    ['scripts/deploy.zsh', 'bash'],
    ['migrations/001_init.sql', 'sql'],
  ])('%s -> %s', (path, expected) => {
    expect(pathToLanguage(path)).toBe(expected)
  })

  test('returns null for an unrecognized extension', () => {
    expect(pathToLanguage('image.png')).toBeNull()
  })

  test('returns null for a path with no extension', () => {
    expect(pathToLanguage('Makefile')).toBeNull()
  })

  test('returns null for a dotfile with no real extension', () => {
    expect(pathToLanguage('.gitignore')).toBeNull()
  })

  test('is case-insensitive on the extension', () => {
    expect(pathToLanguage('Foo.TSX')).toBe('tsx')
  })

  test('resolves the extension from the final path segment', () => {
    expect(pathToLanguage('a.b/c.ts')).toBe('typescript')
  })
})
