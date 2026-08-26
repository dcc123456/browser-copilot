import { beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  })
})

import { workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

/** Returns the `data.values` of all action nodes (skips the trigger node). */
const nodesValues = (entries: HistoryEntry[], name = 'wf') =>
  (workflowFromHistory(entries, name)?.drawflow.nodes ?? [])
    .filter((n) => n.data.blockId !== 'manual')
    .map((n) => n.data.values)

describe('selectorFromArgs target synthesis', () => {
  it("how:'css' keeps the trimmed selector", () => {
    const values = nodesValues([entry('click', { target: { primary: { how: 'css', value: ' .btn ' } } })])
    expect(values).toEqual([{ cssSelector: '.btn' }])
  })

  it("how:'id' yields a #id selector", () => {
    const values = nodesValues([entry('click', { target: { primary: { how: 'id', value: 'submit' } } })])
    expect(values).toEqual([{ cssSelector: '#submit' }])
  })

  it("how:'name' yields a [name=...] selector", () => {
    const values = nodesValues([entry('click', { target: { primary: { how: 'name', value: 'q' } } })])
    expect(values).toEqual([{ cssSelector: '[name="q"]' }])
  })

  it("how:'testid' yields a [data-testid=...] selector", () => {
    const values = nodesValues([entry('click', { target: { primary: { how: 'testid', value: 'x' } } })])
    expect(values).toEqual([{ cssSelector: '[data-testid="x"]' }])
  })
})

describe('args fall through to mapped block values', () => {
  it('fill combines a synthesized selector with a literal value', () => {
    const wf = workflowFromHistory(
      [entry('fill', { target: { primary: { how: 'id', value: 'n' } }, value: 'abc' })],
      'wf',
    )
    // 1 trigger + 1 action
    expect(wf?.drawflow.nodes).toHaveLength(2)
    expect(wf?.drawflow.nodes[1]!.data.values).toEqual({ cssSelector: '#n', value: 'abc' })
  })

  it('press_key carries through the key', () => {
    expect(nodesValues([entry('press_key', { key: 'Enter' })])).toEqual([{ key: 'Enter' }])
  })

  it('scroll keeps mode/y instead of hard-coding into_view', () => {
    const values = nodesValues([
      entry('scroll', { mode: 'by', y: 100, target: { primary: { how: 'css', value: '.x' } } }),
    ])
    expect(values).toEqual([{ mode: 'by', cssSelector: '.x', y: 100 }])
  })

  it('wait_for carries the timeout', () => {
    const values = nodesValues([
      entry('wait_for', { target: { primary: { how: 'css', value: '.a' } }, timeout: 3000 }),
    ])
    expect(values).toEqual([{ cssSelector: '.a', timeout: 3000 }])
  })

  it('tab_switch carries the index', () => {
    expect(nodesValues([entry('tab_switch', { index: 2 })])).toEqual([{ index: 2 }])
  })

  it('open_url carries the url', () => {
    expect(nodesValues([entry('open_url', { url: 'https://e.com' })])).toEqual([
      { url: 'https://e.com' },
    ])
  })
})

describe('trigger node', () => {
  it('prepends a manual trigger node connected to the first action', () => {
    const wf = workflowFromHistory(
      [entry('click', { target: { primary: { how: 'css', value: '.btn' } } })],
      'wf',
    )
    expect(wf).not.toBeNull()
    // trigger + 1 action
    expect(wf!.drawflow.nodes).toHaveLength(2)
    expect(wf!.drawflow.edges).toHaveLength(1)
    expect(wf!.drawflow.nodes[0]!.data.blockId).toBe('manual')
    expect(wf!.drawflow.edges[0]!.source).toBe(wf!.drawflow.nodes[0]!.id)
    expect(wf!.drawflow.edges[0]!.target).toBe(wf!.drawflow.nodes[1]!.id)
  })
})

describe('unmapped actions', () => {
  it('returns null when nothing is mappable', () => {
    expect(workflowFromHistory([entry('read_current_page', {})], 'wf')).toBeNull()
  })

  it('skips unmapped actions and links the mapped ones in order', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('read_current_page', {}),
        entry('click', { target: { primary: { how: 'testid', value: 'x' } } }),
      ],
      'wf',
    )
    expect(wf).not.toBeNull()
    // trigger + open_url + click = 3
    expect(wf!.drawflow.nodes).toHaveLength(3)
    // trigger→open_url + open_url→click = 2
    expect(wf!.drawflow.edges).toHaveLength(2)
    expect(
      wf!.drawflow.nodes
        .filter((n) => n.data.blockId !== 'manual')
        .map((n) => n.data.values),
    ).toEqual([{ url: 'https://e.com' }, { cssSelector: '[data-testid="x"]' }])
    // First edge: trigger → first action
    expect(wf!.drawflow.edges[0]!.source).toBe(wf!.drawflow.nodes[0]!.id)
    expect(wf!.drawflow.edges[0]!.target).toBe(wf!.drawflow.nodes[1]!.id)
    // Second edge: first action → second action
    expect(wf!.drawflow.edges[1]!.source).toBe(wf!.drawflow.nodes[1]!.id)
    expect(wf!.drawflow.edges[1]!.target).toBe(wf!.drawflow.nodes[2]!.id)
  })
})

describe('duplicate collapsing', () => {
  it('collapses consecutive open_url calls to the same URL into one block', () => {
    // Reproduces the saved workflow where the model opened the same URL twice
    // (e.g. once to navigate and again after a re-read). A replayable workflow
    // only needs the navigation once.
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://github.com/pulls/review-requested' }),
        entry('read_current_page', {}),
        entry('open_url', { url: 'https://github.com/pulls/review-requested' }),
      ],
      'prs',
    )
    expect(wf).not.toBeNull()
    const actionNodes = wf!.drawflow.nodes.filter((n) => n.data.blockId !== 'manual')
    expect(actionNodes).toHaveLength(1)
    expect(actionNodes[0]!.data.values).toEqual({
      url: 'https://github.com/pulls/review-requested',
    })
  })

  it('keeps two open_url calls when the URLs differ', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('open_url', { url: 'https://b.com' }),
      ],
      'wf',
    )
    const actionNodes = wf!.drawflow.nodes.filter((n) => n.data.blockId !== 'manual')
    expect(actionNodes).toHaveLength(2)
  })

  it('collapses two clicks on the same selector but keeps clicks on different ones', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }),
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }),
      ],
      'wf',
    )
    const selectors = wf!.drawflow.nodes
      .filter((n) => n.data.blockId !== 'manual')
      .map((n) => n.data.values.cssSelector)
    expect(selectors).toEqual(['.a', '.b'])
  })
})
