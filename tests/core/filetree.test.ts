import { describe, expect, test } from 'bun:test'
import { buildFileTree } from '../../src/core/filetree.ts'

/**
 * Turning a flat path list into what a file browser renders — grouping by directory and
 * sorting, since `ProjectTree.list()` promises neither.
 */

describe('building a tree from a flat path list', () => {
  test('an empty list produces an empty tree', () => {
    expect(buildFileTree([])).toEqual([])
  })

  test('a single top-level file', () => {
    expect(buildFileTree(['a.ts'])).toEqual([{ kind: 'file', name: 'a.ts', path: 'a.ts' }])
  })

  test('nests a file under its directory', () => {
    expect(buildFileTree(['src/a.ts'])).toEqual([
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [{ kind: 'file', name: 'a.ts', path: 'src/a.ts' }],
      },
    ])
  })

  test('two files in the same directory share one directory node', () => {
    const tree = buildFileTree(['src/a.ts', 'src/b.ts'])
    expect(tree).toEqual([
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [
          { kind: 'file', name: 'a.ts', path: 'src/a.ts' },
          { kind: 'file', name: 'b.ts', path: 'src/b.ts' },
        ],
      },
    ])
  })

  test('directories sort before files, both alphabetically', () => {
    const tree = buildFileTree(['z.ts', 'src/a.ts', 'a.ts'])
    expect(tree.map((node) => node.name)).toEqual(['src', 'a.ts', 'z.ts'])
  })

  test('deep nesting resolves every ancestor to the same directory node', () => {
    const tree = buildFileTree(['a/b/c/one.ts', 'a/b/c/two.ts', 'a/b/other.ts'])
    expect(tree).toEqual([
      {
        kind: 'dir',
        name: 'a',
        path: 'a',
        children: [
          {
            kind: 'dir',
            name: 'b',
            path: 'a/b',
            children: [
              {
                kind: 'dir',
                name: 'c',
                path: 'a/b/c',
                children: [
                  { kind: 'file', name: 'one.ts', path: 'a/b/c/one.ts' },
                  { kind: 'file', name: 'two.ts', path: 'a/b/c/two.ts' },
                ],
              },
              { kind: 'file', name: 'other.ts', path: 'a/b/other.ts' },
            ],
          },
        ],
      },
    ])
  })
})
