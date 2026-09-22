import { describe, expect, test } from 'bun:test'
import { languageFor } from '../../../../src/adapters/web/ui/editor/language.ts'
import { CURATED_LANGUAGES, pathToLanguage } from '../../../../src/core/language.ts'

describe('languageFor', () => {
  test('every language the domain curates has a CodeMirror grammar', () => {
    const missing = CURATED_LANGUAGES.filter((language) => languageFor(language) === null)
    expect(missing).toEqual([])
  })

  test('a file the domain does not curate renders as plain text', () => {
    expect(pathToLanguage('notes.brainfuck')).toBeNull()
    expect(languageFor(null)).toBeNull()
  })

  test('a language id with no grammar renders as plain text rather than throwing', () => {
    expect(languageFor('cuneiform')).toBeNull()
  })

  test('typescript and tsx resolve to different configurations', () => {
    expect(languageFor('typescript')).not.toBeNull()
    expect(languageFor('tsx')).not.toBeNull()
  })
})
