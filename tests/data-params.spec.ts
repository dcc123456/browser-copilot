/**
 * The data/structural split is the contract the whole "no dead data" rule rests
 * on: get it wrong in the structural direction and a selector gets rewritten
 * into a nonsense reference; wrong in the data direction and a frozen keyword
 * ships in the workflow. These tests pin both edges plus the nested shapes.
 */
import { describe, expect, it } from 'vitest'
import {
  dataParamSpecs,
  dataValueSites,
  hasDataParams,
  isDataParam,
} from '../src/lib/workflow/data-params'

describe('isDataParam', () => {
  it('treats a value written into the page as data', () => {
    expect(isDataParam('forms', 'value')).toBe(true)
    expect(isDataParam('set-variable', 'value')).toBe(true)
    expect(isDataParam('notification', 'message')).toBe(true)
    expect(isDataParam('ai-agent', 'prompt')).toBe(true)
  })

  it('treats a locator as structural', () => {
    // The whole point: a selector is the step's identity, not its data.
    for (const key of ['selector', 'findBy', 'target', 'attributeName', 'variableName']) {
      expect(isDataParam('forms', key)).toBe(false)
    }
  })

  it('treats a URL as data but a trigger match pattern as structural', () => {
    expect(isDataParam('new-tab', 'url')).toBe(true)
    expect(isDataParam('webhook', 'url')).toBe(true)
    expect(isDataParam('trigger', 'url')).toBe(false)
  })

  it('keeps the trigger free of data params — its parameters ARE the inputs', () => {
    expect(dataParamSpecs('trigger')).toEqual([])
    expect(hasDataParams('trigger')).toBe(false)
  })

  it('defaults an unknown block to structural', () => {
    // Rewriting a parameter this table has never seen risks corrupting an
    // imported workflow, so the safe direction is "don't touch".
    expect(dataParamSpecs('some-future-block')).toEqual([])
    expect(isDataParam('some-future-block', 'value')).toBe(false)
  })

  it('knows which blocks have data at all', () => {
    expect(hasDataParams('forms')).toBe(true)
    expect(hasDataParams('event-click')).toBe(false)
  })
})

describe('dataValueSites', () => {
  it('finds a plain scalar param', () => {
    const sites = dataValueSites('forms', {
      selector: '#q',
      findBy: 'cssSelector',
      value: 'iPhone',
    })
    expect(sites).toEqual([{ path: ['value'], value: 'iPhone' }])
  })

  it('finds the compared value in an array of condition rows', () => {
    const sites = dataValueSites('conditions', {
      conditions: [
        { left: '{{price}}', operator: 'gt', right: '100' },
        { left: '{{stock}}', operator: 'lt', right: '5' },
      ],
    })
    expect(sites).toEqual([
      { path: ['conditions', 0, 'right'], value: '100' },
      { path: ['conditions', 1, 'right'], value: '5' },
    ])
  })

  it("does not treat a condition row's `left` as data", () => {
    // `left` names a variable; rewriting it would break the comparison.
    const sites = dataValueSites('conditions', {
      conditions: [{ left: 'price', operator: 'gt', right: '100' }],
    })
    expect(sites.map((s) => s.path)).toEqual([['conditions', 0, 'right']])
  })

  it('walks a deep subtree', () => {
    const sites = dataValueSites('webhook', {
      method: 'POST',
      url: 'https://api.example/ingest',
      body: { title: 'Hello', meta: { source: 'web' } },
    })
    expect(sites).toEqual([
      { path: ['url'], value: 'https://api.example/ingest' },
      { path: ['body', 'title'], value: 'Hello' },
      { path: ['body', 'meta', 'source'], value: 'web' },
    ])
  })

  it('does NOT recurse into a scalar param that unexpectedly holds an object', () => {
    // `forms.value` is a scalar slot. An object there is a malformed node, and
    // silently treating its innards as rewritable data would corrupt it.
    const sites = dataValueSites('forms', { value: { nested: 'oops' } })
    expect(sites).toEqual([])
  })

  it('skips blank and whitespace-only values', () => {
    expect(dataValueSites('forms', { value: '' })).toEqual([])
    expect(dataValueSites('forms', { value: '   ' })).toEqual([])
  })

  it('skips absent params entirely', () => {
    expect(dataValueSites('forms', { selector: '#q' })).toEqual([])
  })

  it('skips non-string scalars rather than coercing them', () => {
    expect(dataValueSites('forms', { value: 42 })).toEqual([])
  })

  it('reports an empty result for a structural-only block', () => {
    expect(dataValueSites('event-click', { selector: '#go', multiple: false })).toEqual([])
  })
})
