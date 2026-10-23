/**
 * Dotted references into a value a block stored as TEXT.
 *
 * Round 56 generated an ai-agent node asked for `{title, body}`, then a `forms`
 * step referencing `{{articleData.title}}`. The executor stores the answer as a
 * string — it cannot know whether the consumer wants the document or the
 * sentence — and the reference side is where that is decidable, so a dotted path
 * reaching a JSON string now parses it. Without this the token survives
 * interpolation and the engine dies with `UNRESOLVED_INPUT` on a graph whose
 * producer genuinely ran.
 */
import { describe, it, expect } from 'vitest'
import { getByPath, interpolate, parseReference } from '../src/lib/workflow/interpolate'

describe('a dotted path into a JSON string', () => {
  const doc = '{"title":"AI 超能力","body":"装上就能自动干活"}'

  it('resolves the field the reference asked for', () => {
    expect(interpolate('{{articleData.title}}', { articleData: doc })).toBe('AI 超能力')
  })

  it('reads through a fenced answer, which is what a model actually returns', () => {
    expect(interpolate('{{a.body}}', { a: '```json\n' + doc + '\n```' })).toBe('装上就能自动干活')
  })

  it('walks arrays and deeper objects', () => {
    expect(getByPath({ d: '{"items":[{"n":7}]}' }, 'd.items.0.n')).toBe(7)
  })

  it('leaves the whole value alone when the reference names no field', () => {
    expect(interpolate('{{articleData}}', { articleData: doc })).toBe(doc)
  })

  it('still refuses a field on prose that was never JSON', () => {
    expect(interpolate('{{note.title}}', { note: '正文写好了，标题在图里。' })).toBe(
      '{{note.title}}',
    )
  })

  it('does not treat a JSON scalar as a document', () => {
    expect(getByPath({ d: '123' }, 'd.title')).toBeUndefined()
  })
})

describe('bracket access into arrays and objects', () => {
  const rows = [{ name: 'Ada', tags: ['x', 'y'] }, { name: 'Bob' }]

  it('reads an array item index and a property after it', () => {
    expect(interpolate('{{rows[0].name}}', { rows })).toBe('Ada')
    expect(interpolate('{{rows[1].name}}', { rows })).toBe('Bob')
    expect(interpolate('{{rows[0].tags[1]}}', { rows })).toBe('y')
  })

  it('reads quoted keys, including ones with dots and spaces', () => {
    const bag = { obj: { 'full name': 'Ada Lovelace', 'a.b': 7 } }
    expect(interpolate('{{obj["full name"]}}', bag)).toBe('Ada Lovelace')
    expect(interpolate("{{obj['a.b']}}", bag)).toBe('7')
  })

  it('accepts whitespace around the index', () => {
    expect(interpolate('{{ rows[ 0 ].name }}', { rows })).toBe('Ada')
  })

  it('parses a JSON document hidden in a string at the bracket step', () => {
    const doc = '{"title":"AI 超能力","items":[{"n":7}]}'
    expect(interpolate('{{articleData["title"]}}', { articleData: doc })).toBe('AI 超能力')
    expect(getByPath({ d: doc }, 'd.items[0]["n"]')).toBe(7)
  })

  it('keeps the token when an index or key is missing', () => {
    expect(interpolate('{{rows[9].name}}', { rows })).toBe('{{rows[9].name}}')
    expect(interpolate('{{obj["nope"]}}', { obj: { yes: 1 } })).toBe('{{obj["nope"]}}')
  })

  it('keeps malformed bracket expressions verbatim', () => {
    expect(interpolate('{{rows[]}}', { rows })).toBe('{{rows[]}}')
    expect(interpolate('{{rows[0}}', { rows })).toBe('{{rows[0}}')
    expect(interpolate('{{rows[0]name}}', { rows })).toBe('{{rows[0]name}}')
  })

  it('supports the refData root', () => {
    expect(interpolate('{{refData[0].id}}', {}, [{ id: 3 }])).toBe('3')
  })

  it('walks bracket paths through getByPath and rejects an empty path', () => {
    expect(getByPath({ a: [{ b: 1 }] }, 'a[0].b')).toBe(1)
    expect(getByPath({ a: { 'x.y': 2 } }, 'a["x.y"]')).toBe(2)
    expect(getByPath({ a: 1 }, 'a[')).toBeUndefined()
    expect(getByPath({ a: 1 }, '')).toBeUndefined()
  })

  it('parses the reference grammar explicitly', () => {
    expect(parseReference('rows[0].name')).toEqual({ name: 'rows', path: ['0', 'name'] })
    expect(parseReference('obj["a.b"]')).toEqual({ name: 'obj', path: ['a.b'] })
    expect(parseReference('rows')).toEqual({ name: 'rows', path: [] })
    expect(parseReference('a..b')).toBeUndefined()
  })
})
