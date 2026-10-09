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
import { getByPath, interpolate } from '../src/lib/workflow/interpolate'

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
