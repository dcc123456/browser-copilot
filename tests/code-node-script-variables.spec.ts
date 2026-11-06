/**
 * The javascript-code editor's `/` variable menu, as pure logic.
 *
 * The editor receives `variables` as a parameter, so a reference is written as
 * `variables.name` (or `variables["name"]` when the name is not an identifier).
 * The slash rules are shared with block-parameter fields, which is what keeps a
 * URL, a path or a date from opening the menu.
 */
import { describe, expect, it } from 'vitest'
import {
  scriptVariableCompletions,
  scriptVariableReference,
} from '../src/lib/workflow/code-node-helpers'

const VARIABLES = [
  { name: 'lastText', hint: 'get-text' },
  { name: 'summary' },
  { name: 'autoSummary' },
  { name: '标题' },
]

describe('scriptVariableReference', () => {
  it('uses dot access for identifier-safe names', () => {
    expect(scriptVariableReference('lastText')).toBe('variables.lastText')
    expect(scriptVariableReference('_draft')).toBe('variables._draft')
    expect(scriptVariableReference('$row2')).toBe('variables.$row2')
    expect(scriptVariableReference('标题')).toBe('variables.标题')
  })

  it('falls back to bracket access so any name still reads', () => {
    expect(scriptVariableReference('user.name')).toBe('variables["user.name"]')
    expect(scriptVariableReference('has space')).toBe('variables["has space"]')
    expect(scriptVariableReference('2fa')).toBe('variables["2fa"]')
    expect(scriptVariableReference('a"b')).toBe('variables["a\\"b"]')
  })
})

describe('scriptVariableCompletions', () => {
  const line = 'const title = /'
  const caret = line.length

  it('opens on a word-start slash and lists every variable', () => {
    const result = scriptVariableCompletions(line, caret, VARIABLES)
    expect(result?.from).toBe(line.indexOf('/'))
    expect(result?.options.map((option) => option.label)).toEqual([
      'lastText',
      'summary',
      'autoSummary',
      '标题',
    ])
    expect(result?.options.find((option) => option.label === 'lastText')).toEqual({
      label: 'lastText',
      detail: 'get-text',
      apply: 'variables.lastText',
    })
    expect(result?.options.find((option) => option.label === 'summary')).toEqual({
      label: 'summary',
      apply: 'variables.summary',
    })
  })

  it('ranks prefix matches first and searches the hint too', () => {
    const term = 'x = /su'
    const prefix = scriptVariableCompletions(term, term.length, VARIABLES)
    expect(prefix?.options.map((option) => option.label)).toEqual(['summary', 'autoSummary'])

    const hint = 'x = /get-'
    const hinted = scriptVariableCompletions(hint, hint.length, VARIABLES)
    expect(hinted?.options.map((option) => option.label)).toEqual(['lastText'])
  })

  it('matches a name typed in another script', () => {
    const chinese = 'x = /标'
    const result = scriptVariableCompletions(chinese, chinese.length, VARIABLES)
    expect(result?.options.map((option) => option.label)).toEqual(['标题'])
    expect(result?.options[0]?.apply).toBe('variables.标题')
  })

  it('keeps from line-relative, not document-relative', () => {
    const indented = '  const title = /la'
    const result = scriptVariableCompletions(indented, indented.length, VARIABLES)
    expect(result?.from).toBe(indented.indexOf('/'))
  })

  it('stays closed for URLs, paths, dates and mid-word slashes', () => {
    for (const text of ['https://example.com', 'const p = src/lib', 'const half = 3/4', 'a/b']) {
      expect(scriptVariableCompletions(text, text.length, VARIABLES), text).toBeNull()
    }
  })

  it('stays closed for comments', () => {
    expect(scriptVariableCompletions('//', 2, VARIABLES)).toBeNull()
    expect(scriptVariableCompletions('// note', 2, VARIABLES)).toBeNull()
    expect(scriptVariableCompletions('/*', 2, VARIABLES)).toBeNull()
  })

  it('returns null when nothing matches or there is nothing to offer', () => {
    expect(scriptVariableCompletions('x = /zzz', 8, VARIABLES)).toBeNull()
    expect(scriptVariableCompletions('x = /', 5, [])).toBeNull()
  })
})
