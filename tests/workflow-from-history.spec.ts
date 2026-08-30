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
function entry(action: string, args?: Args, host?: string): HistoryEntry {
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
    ...(host ? { host } : {}),
  }
}

/** Flat catalog data of every action node (trigger excluded), in workflow order. */
const actionData = (entries: HistoryEntry[], name = 'wf') =>
  (workflowFromHistory(entries, name)?.drawflow.nodes ?? [])
    .filter((n) => n.data.blockId !== 'trigger')
    .map((n) => n.data)

describe('selectorFromArgs target synthesis', () => {
  it("how:'css' keeps the trimmed selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'css', value: ' .btn ' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '.btn',
        findBy: 'cssSelector',
        target: { primary: { how: 'css', value: ' .btn ' } },
      },
    ])
  })

  it("how:'id' yields a #id selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'id', value: 'submit' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '#submit',
        findBy: 'cssSelector',
        target: { primary: { how: 'id', value: 'submit' } },
      },
    ])
  })

  it("how:'name' yields a [name=...] selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'name', value: 'q' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '[name="q"]',
        findBy: 'cssSelector',
        target: { primary: { how: 'name', value: 'q' } },
      },
    ])
  })

  it("how:'testid' yields a [data-testid=...] selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'testid', value: 'x' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '[data-testid="x"]',
        findBy: 'cssSelector',
        target: { primary: { how: 'testid', value: 'x' } },
      },
    ])
  })
})

describe('args fall through to flat block data', () => {
  it('fill combines a synthesized selector with a literal value (no legacy values bag)', () => {
    const wf = workflowFromHistory(
      [entry('fill', { target: { primary: { how: 'id', value: 'n' } }, value: 'abc' })],
      'wf',
    )
    // 1 trigger + 1 action
    expect(wf?.drawflow.nodes).toHaveLength(2)
    const data = wf!.drawflow.nodes[1]!.data
    expect(data).toEqual({
      blockId: 'forms',
      description: '',
      selector: '#n',
      findBy: 'cssSelector',
      type: 'text-field',
      value: 'abc',
      clearValue: true,
      target: { primary: { how: 'id', value: 'n' } },
    })
    // The editor reads `selector`/`findBy` — the legacy `values` bag must stay gone.
    expect(data).not.toHaveProperty('values')
  })

  it('press_key carries through the key', () => {
    expect(actionData([entry('press_key', { key: 'Enter' })])).toEqual([
      { blockId: 'press-key', description: 'press_key', key: 'Enter' },
    ])
  })

  it('scroll maps mode/y to scrollX/scrollY (a target, if any, is not attached)', () => {
    expect(
      actionData([
        entry('scroll', { mode: 'by', y: 100, target: { primary: { how: 'css', value: '.x' } } }),
      ]),
    ).toEqual([{ blockId: 'element-scroll', description: '', scrollX: 0, scrollY: 100 }])
  })

  it('wait_for becomes a delay block carrying the timeout as delay time', () => {
    expect(
      actionData([
        entry('wait_for', { target: { primary: { how: 'css', value: '.a' } }, timeout: 3000 }),
      ]),
    ).toEqual([{ blockId: 'delay', description: '', time: 3000 }])
  })

  it('tab_switch carries the index', () => {
    expect(actionData([entry('tab_switch', { index: 2 })])).toEqual([
      { blockId: 'switch-tab', description: 'tab_switch', index: 2 },
    ])
  })

  it('open_url becomes new-tab plus a trailing page-load wait', () => {
    expect(actionData([entry('open_url', { url: 'https://e.com' })])).toEqual([
      { blockId: 'new-tab', description: 'open_url', url: 'https://e.com', waitTabLoaded: true },
      { blockId: 'wait-connections', description: '等待页面加载', timeout: 10000 },
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
    expect(wf!.drawflow.nodes[0]!.data.blockId).toBe('trigger')
    expect(wf!.drawflow.nodes[0]!.data.type).toBe('manual')
    expect(wf!.drawflow.edges[0]!.source).toBe(wf!.drawflow.nodes[0]!.id)
    expect(wf!.drawflow.edges[0]!.target).toBe(wf!.drawflow.nodes[1]!.id)
  })
})

describe('page-load wait insertion', () => {
  it('always appends the wait after navigation; a same-host click adds no second wait', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('click', { target: { primary: { how: 'css', value: '.btn' } } }, 'a.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'event-click',
    ])
  })

  it('clicks add the wait only when the host changes mid-flow', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }, 'a.com'),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }, 'b.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'event-click',
      'wait-connections',
      'event-click',
    ])
    expect(wf!.drawflow.nodes[2]!.data).toEqual({
      blockId: 'wait-connections',
      description: '等待页面加载',
      timeout: 10000,
    })
  })

  it('clicks on the same host stay wait-free', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }, 'a.com'),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }, 'a.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'event-click', 'event-click'])
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
    // trigger + new-tab + wait + click = 4
    expect(wf!.drawflow.nodes).toHaveLength(4)
    // trigger→new-tab→wait→click = 3
    expect(wf!.drawflow.edges).toHaveLength(3)
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'event-click',
    ])
    // Edges chain every node in order
    wf!.drawflow.edges.forEach((edge, i) => {
      expect(edge.source).toBe(wf!.drawflow.nodes[i]!.id)
      expect(edge.target).toBe(wf!.drawflow.nodes[i + 1]!.id)
    })
  })
})

describe('duplicate collapsing', () => {
  it('collapses consecutive open_url calls to the same URL into one block (with its wait)', () => {
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
    const actionNodes = wf!.drawflow.nodes.filter((n) => n.data.blockId !== 'trigger')
    expect(actionNodes).toHaveLength(2)
    expect(actionNodes[0]!.data).toEqual({
      blockId: 'new-tab',
      description: 'open_url',
      url: 'https://github.com/pulls/review-requested',
      waitTabLoaded: true,
    })
    expect(actionNodes[1]!.data).toEqual({
      blockId: 'wait-connections',
      description: '等待页面加载',
      timeout: 10000,
    })
  })

  it('keeps two open_url calls when the URLs differ (each with its own wait)', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('open_url', { url: 'https://b.com' }),
      ],
      'wf',
    )
    // trigger + 2 × (new-tab + wait)
    expect(wf!.drawflow.nodes).toHaveLength(5)
    expect(
      wf!.drawflow.nodes.filter((n) => n.data.blockId === 'new-tab').map((n) => n.data.url),
    ).toEqual(['https://a.com', 'https://b.com'])
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
    expect(
      wf!.drawflow.nodes
        .filter((n) => n.data.blockId !== 'trigger')
        .map((n) => n.data.selector),
    ).toEqual(['.a', '.b'])
  })

  it('keeps only the last value when the same field is filled twice', () => {
    const wf = workflowFromHistory(
      [
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'one' }),
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'two' }),
      ],
      'wf',
    )
    // trigger + 1 forms node (the last fill wins)
    expect(wf!.drawflow.nodes).toHaveLength(2)
    expect(wf!.drawflow.nodes[1]!.data).toEqual({
      blockId: 'forms',
      description: '',
      selector: '#q',
      findBy: 'cssSelector',
      type: 'text-field',
      value: 'two',
      clearValue: true,
      target: { primary: { how: 'id', value: 'q' } },
    })
  })
})

describe('run_javascript maps to the javascript-code block', () => {
  it('carries the code and the catalog timeout', () => {
    expect(actionData([entry('run_javascript', { code: 'return document.title' })])).toEqual([
      {
        blockId: 'javascript-code',
        description: 'run_javascript',
        code: 'return document.title',
        timeout: 20000,
      },
    ])
  })

  it('keeps its place in the flow between mapped steps', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('run_javascript', { code: 'return document.title' }),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'javascript-code',
    ])
  })
})

describe('rich conversation targets', () => {
  it('role-targeted clicks keep an empty selector plus the verbatim target', () => {
    const target = {
      primary: { how: 'role', value: '提交', role: 'button' },
      fallbacks: [{ how: 'text', value: '提交' }],
    }
    expect(actionData([entry('click', { target })])).toEqual([
      // selector is empty (role/text) — the description falls back to the
      // action summary so the canvas card still says something useful.
      { blockId: 'event-click', description: 'click', selector: '', findBy: 'cssSelector', target },
    ])
  })

  it('an into_view scroll keeps its element target even without a CSS selector', () => {
    const target = { primary: { how: 'role', value: '列表', role: 'region' }, fallbacks: [] }
    expect(actionData([entry('scroll', { mode: 'into_view', target })])).toEqual([
      {
        blockId: 'element-scroll',
        description: 'scroll',
        selector: '',
        findBy: 'cssSelector',
        scrollIntoView: true,
        target,
      },
    ])
  })
})
