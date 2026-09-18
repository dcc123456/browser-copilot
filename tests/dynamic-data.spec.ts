/**
 * The rewrite is the mechanism that makes a generated workflow reusable, so
 * these tests cover the two sources it can draw on (upstream variable vs a
 * declared input) plus the failure modes that would corrupt a graph: stealing
 * a declared name, mutating the parameters the live page still needs, and
 * mangling a name into something `{{...}}` cannot carry.
 */
import { describe, expect, it } from 'vitest'
import {
  buildVariableIndex,
  hasReference,
  inputNameFor,
  rewriteDataParams,
} from '../src/lib/workflow/dynamic-data'

const NO_VARS = new Map<string, string>()
const NO_DECLARED = new Map<string, string>()

describe('hasReference', () => {
  it('detects a token anywhere in the string', () => {
    expect(hasReference('{{kw}}')).toBe(true)
    expect(hasReference('搜索 {{kw}} 的结果')).toBe(true)
    expect(hasReference('iPhone')).toBe(false)
    expect(hasReference('{ {kw} }')).toBe(false)
  })
})

describe('buildVariableIndex', () => {
  it('maps string leaves to their variable name', () => {
    const index = buildVariableIndex({ title: 'iPhone 16', price: '5999' })
    expect(index.get('iPhone 16')).toBe('title')
    expect(index.get('5999')).toBe('price')
  })

  it('sees through rows and nested objects', () => {
    const index = buildVariableIndex({
      rows: [{ name: '张三' }, { name: '李四' }],
      meta: { city: '北京' },
    })
    expect(index.get('张三')).toBe('rows')
    expect(index.get('李四')).toBe('rows')
    expect(index.get('北京')).toBe('meta')
  })

  it('excludes credential variables so secret-guard owns them', () => {
    const index = buildVariableIndex(
      { password: 'hunter2secret', keyword: 'shoes' },
      new Set(['password']),
    )
    expect(index.has('hunter2secret')).toBe(false)
    expect(index.get('shoes')).toBe('keyword')
  })

  it('ignores empty strings', () => {
    expect(buildVariableIndex({ blank: '' }).size).toBe(0)
  })
})

describe('inputNameFor', () => {
  it('derives a readable name from block id and param', () => {
    expect(inputNameFor('new-tab', 'url')).toBe('newTabUrl')
    expect(inputNameFor('forms', 'value')).toBe('formsValue')
    expect(inputNameFor('webhook', 'body')).toBe('webhookBody')
  })

  it('never emits a name that would break the {{...}} syntax', () => {
    // A dot would be read as a nested path by `getByPath`; braces would break
    // the token regex. Neither may survive.
    for (const name of [inputNameFor('some.block', 'a.b'), inputNameFor('weird id!', 'value')]) {
      expect(name).not.toContain('.')
      expect(name).not.toContain('{')
      expect(name).not.toContain('}')
      expect(name).toMatch(/^[A-Za-z0-9_]+$/)
    }
  })

  it('avoids the reserved refData name', () => {
    expect(inputNameFor('ref', 'data')).not.toBe('refData')
  })
})

describe('rewriteDataParams', () => {
  it('references an upstream variable when one already holds the value', () => {
    const index = buildVariableIndex({ lastTitle: 'iPhone 16' })
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { selector: '#q', value: 'iPhone 16' },
      variableIndex: index,
      declared: NO_DECLARED,
    })
    expect(result.data['value']).toBe('{{lastTitle}}')
    expect(result.rewrites).toEqual([
      { path: ['value'], from: 'iPhone 16', to: '{{lastTitle}}', via: 'upstream' },
    ])
    // Nothing to declare: the graph can produce this value on its own.
    expect(result.newInputs).toEqual([])
  })

  it('declares an input when nothing in the graph can produce the value', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { selector: '#q', value: 'iPhone' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data['value']).toBe('{{formsValue}}')
    expect(result.newInputs).toEqual([
      {
        name: 'formsValue',
        defaultValue: 'iPhone',
        description: 'recorded from forms.value during generation',
      },
    ])
  })

  it('marks a credential literal as a secret input via secretPaths', () => {
    // A chat-typed password (path ['value']) must be captured as a `secret`
    // trigger input, not a plain one, so it is masked in the editor and treated
    // as a credential at replay.
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { selector: '#pw', value: 'hunter2' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
      secretPaths: new Set([JSON.stringify(['value'])]),
    })
    expect(result.data['value']).toBe('{{formsValue}}')
    expect(result.newInputs).toEqual([
      {
        name: 'formsValue',
        defaultValue: 'hunter2',
        description: 'recorded from forms.value during generation',
        secret: true,
      },
    ])
  })

  it('leaves a non-credential literal as a plain input (no secretPaths)', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { selector: '#q', value: 'Ada Lovelace' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.newInputs[0]!.secret).toBeUndefined()
  })

  it('honours the model-supplied name for the first value', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { selector: '#q', value: 'iPhone' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
      nameHint: 'keyword',
    })
    expect(result.data['value']).toBe('{{keyword}}')
    expect(result.newInputs[0]!.name).toBe('keyword')
  })

  it('applies the hint only once so a second value gets its own name', () => {
    const result = rewriteDataParams({
      blockId: 'webhook',
      data: { url: 'https://a.example', body: { note: 'hi' } },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
      nameHint: 'target',
    })
    expect(result.data['url']).toBe('{{target}}')
    expect(result.data['body']).toEqual({ note: '{{webhookNote}}' })
    expect(result.newInputs.map((i) => i.name)).toEqual(['target', 'webhookNote'])
  })

  it('leaves a parameter that is already a reference alone', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { value: '{{keyword}}' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data['value']).toBe('{{keyword}}')
    expect(result.rewrites).toEqual([])
    expect(result.newInputs).toEqual([])
  })

  it('leaves a partially-templated string alone', () => {
    // The model chose to mix text and tokens; second-guessing it here would
    // destroy the literal parts.
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { value: '搜索 {{kw}} 的结果' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data['value']).toBe('搜索 {{kw}} 的结果')
    expect(result.rewrites).toEqual([])
  })

  it('never touches structural parameters', () => {
    const result = rewriteDataParams({
      blockId: 'event-click',
      data: { selector: '#submit', findBy: 'cssSelector', multiple: false },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data).toEqual({
      selector: '#submit',
      findBy: 'cssSelector',
      multiple: false,
    })
    expect(result.newInputs).toEqual([])
  })

  it('skips boolean literals — a checkbox state is not business data', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { type: 'checkbox', value: 'true' },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data['value']).toBe('true')
    expect(result.newInputs).toEqual([])
  })

  it("does NOT mutate the caller's parameters", () => {
    // The caller still has to drive the live page with the REAL values, so the
    // original bag must survive the rewrite untouched.
    const original = { selector: '#q', value: 'iPhone', body: { note: 'hi' } }
    const snapshot = JSON.parse(JSON.stringify(original))
    rewriteDataParams({
      blockId: 'forms',
      data: original,
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(original).toEqual(snapshot)
  })

  it('declares a repeated literal once and references it twice', () => {
    const result = rewriteDataParams({
      blockId: 'conditions',
      data: {
        conditions: [
          { left: '{{a}}', right: '北京' },
          { left: '{{b}}', right: '北京' },
        ],
      },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data['conditions']).toEqual([
      { left: '{{a}}', right: '{{conditionsRight}}' },
      { left: '{{b}}', right: '{{conditionsRight}}' },
    ])
    expect(result.newInputs).toHaveLength(1)
  })

  it('reuses an existing declaration whose default already matches', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { value: 'iPhone' },
      variableIndex: NO_VARS,
      declared: new Map([['keyword', 'iPhone']]),
      nameHint: 'keyword',
    })
    expect(result.data['value']).toBe('{{keyword}}')
    // Already declared with this exact default — declaring again would be noise.
    expect(result.newInputs).toEqual([])
  })

  it('suffixes rather than stealing a name declared with a different value', () => {
    const result = rewriteDataParams({
      blockId: 'forms',
      data: { value: 'Android' },
      variableIndex: NO_VARS,
      declared: new Map([['keyword', 'iPhone']]),
      nameHint: 'keyword',
    })
    // Sharing the name would silently collapse two inputs into one.
    expect(result.data['value']).toBe('{{keyword_2}}')
    expect(result.newInputs[0]).toMatchObject({ name: 'keyword_2', defaultValue: 'Android' })
  })

  it('returns the original object when there is nothing to rewrite', () => {
    const data = { selector: '#q' }
    const result = rewriteDataParams({
      blockId: 'event-click',
      data,
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    expect(result.data).toBe(data)
  })

  it('rewrites inside a nested deep param, naming each leaf distinctly', () => {
    const result = rewriteDataParams({
      blockId: 'webhook',
      data: { method: 'POST', body: { title: '告警', level: 'high' } },
      variableIndex: NO_VARS,
      declared: NO_DECLARED,
    })
    // The HTTP method is structure; the body is payload.
    expect(result.data['method']).toBe('POST')
    expect(result.data['body']).toEqual({
      title: '{{webhookTitle}}',
      level: '{{webhookLevel}}',
    })
  })
})
