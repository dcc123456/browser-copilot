/**
 * Save-time runnability: the page anchor, persisted replay tolerance, the
 * page-anchor predicate, and the save-time selector-hardening pass.
 *
 * The generation session proves each step works; the replay is what fails when
 * the graph never opens a page, when pages render late, or when a locator
 * matched nothing on the tab that happened to be active. These tests pin the
 * guards a regression would silently undo:
 *
 *  1. `persistDefaultWaits` — waits persisted ON the graph at save time,
 *     idempotently, without touching the graph's structure.
 *  2. `unanchoredElementStart` — a graph whose first element action has no
 *     page-opening block before it replays only on the generation-time page.
 *  3. `ensureNavigationAnchor` — that graph gets a `new-tab` of the recorded
 *     origin spliced in front of it, additively and once.
 *  4. `persistDefaultRetries` — every repeat-safe page step gets the pacing the
 *     model used to supply by hand; unsafe and pre-configured steps do not.
 *  5. `hardenWorkflowSelectors` — one batched probe re-picks every recorded
 *     selector, and a refused probe leaves the graph untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureNavigationAnchor,
  persistDefaultRetries,
  persistDefaultWaits,
  unanchoredElementStart,
} from '../src/lib/workflow/runnability'
import { hardenWorkflowSelectors } from '../src/background/selector-probe'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import { newId } from '../src/lib/storage'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, resolveAutomationTab: vi.fn() }
})

import { resolveAutomationTab } from '../src/background/driver'

function node(blockId: string, data: Record<string, unknown> = {}, label?: string): WorkflowNode {
  return {
    id: newId(),
    label: label ?? blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
}

function workflowOf(nodes: WorkflowNode[]): Workflow {
  const trigger = node('trigger', { type: 'manual' })
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: [trigger, ...nodes], edges: [] },
    trigger: { type: 'manual', enabled: true },
  }
}

describe('persistDefaultWaits', () => {
  it('persists waits on interaction blocks only', () => {
    const wf = workflowOf([
      node('new-tab', { url: 'https://example.com' }),
      node('event-click', { selector: '#go' }),
      node('get-text', { selector: '.out' }),
    ])
    const out = persistDefaultWaits(wf)

    const click = out.drawflow.nodes.find((n) => n.data['blockId'] === 'event-click')!
    expect(click.data['waitForSelector']).toBe(true)
    expect(click.data['waitSelectorTimeout']).toBe(5000)
    // Navigation and read blocks are untouched.
    const tab = out.drawflow.nodes.find((n) => n.data['blockId'] === 'new-tab')!
    expect(tab.data['waitForSelector']).toBeUndefined()
    const read = out.drawflow.nodes.find((n) => n.data['blockId'] === 'get-text')!
    expect(read.data['waitForSelector']).toBeUndefined()
  })

  it('keeps a block that already set its own wait', () => {
    const wf = workflowOf([
      node('forms', { selector: '#q', waitForSelector: true, waitSelectorTimeout: 9000 }),
    ])
    const out = persistDefaultWaits(wf)
    const forms = out.drawflow.nodes.find((n) => n.data['blockId'] === 'forms')!
    expect(forms.data['waitSelectorTimeout']).toBe(9000)
  })

  it('is idempotent and never changes the graph structure', () => {
    const wf = workflowOf([node('event-click', { selector: '#go' })])
    const once = persistDefaultWaits(wf)
    const twice = persistDefaultWaits(once)
    expect(twice.drawflow).toEqual(once.drawflow)
    expect(twice.drawflow.nodes.length).toBe(wf.drawflow.nodes.length)
    expect(twice.drawflow.nodes.map((n) => n.id)).toEqual(wf.drawflow.nodes.map((n) => n.id))
    // The input is never mutated.
    const original = wf.drawflow.nodes[1]!
    expect(original.data['waitForSelector']).toBeUndefined()
  })

  it('returns the input unchanged when disabled', () => {
    const wf = workflowOf([node('event-click', { selector: '#go' })])
    expect(persistDefaultWaits(wf, 0)).toBe(wf)
  })
})

describe('unanchoredElementStart', () => {
  it('is true when the graph starts acting on elements directly', () => {
    const wf = workflowOf([
      node('event-click', { selector: '#go' }),
      node('forms', { selector: '#q' }),
    ])
    expect(unanchoredElementStart(wf)).toBe(true)
  })

  it('is false when a new-tab precedes the first element action', () => {
    const wf = workflowOf([
      node('new-tab', { url: 'https://example.com' }),
      node('event-click', { selector: '#go' }),
    ])
    expect(unanchoredElementStart(wf)).toBe(false)
  })

  it('is false for a graph with no element-acting blocks at all', () => {
    const wf = workflowOf([node('delay', { time: 500 })])
    expect(unanchoredElementStart(wf)).toBe(false)
  })
})

describe('ensureNavigationAnchor', () => {
  function anchored(nodes: WorkflowNode[], originUrl?: string): Workflow {
    const wf = workflowOf(nodes)
    if (originUrl) wf.settings.generationOriginUrl = originUrl
    return wf
  }

  it('puts a new-tab opening the origin in front of the chain and rewires the trigger', () => {
    const click = node('event-click', { selector: '#go' })
    const wf = anchored([click], 'https://shop.example/search')
    const trigger = wf.drawflow.nodes[0]!
    wf.drawflow.edges = [{ id: 'e1', source: trigger.id, target: click.id }]

    const out = ensureNavigationAnchor(wf)
    const anchor = out.drawflow.nodes[1]!
    expect(anchor.id).toBe('page-anchor')
    expect(anchor.data['blockId']).toBe('new-tab')
    expect(anchor.data['url']).toBe('https://shop.example/search')
    // trigger → anchor → click, and nothing else moved.
    expect(out.drawflow.nodes.map((n) => n.id)).toEqual([trigger.id, 'page-anchor', click.id])
    expect(out.drawflow.edges.find((e) => e.source === trigger.id)?.target).toBe('page-anchor')
    expect(out.drawflow.edges.find((e) => e.source === 'page-anchor')?.target).toBe(click.id)
    // The splice kept the original edge id, so an editor session does not see
    // the connection as a delete-and-add.
    expect(out.drawflow.edges.find((e) => e.id === 'e1')?.target).toBe('page-anchor')
  })

  it('never touches an existing node', () => {
    const click = node('event-click', { selector: '#go' })
    const wf = anchored([click], 'https://shop.example/')
    const out = ensureNavigationAnchor(wf)
    expect(out.drawflow.nodes.find((n) => n.id === click.id)).toBe(click)
  })

  it('declines a graph that already opens a page, one with no origin, and an anchored graph twice', () => {
    const withNav = anchored([node('new-tab', { url: 'https://x.test' }), node('event-click', {})])
    expect(ensureNavigationAnchor(withNav)).toBe(withNav)

    const noOrigin = anchored([node('event-click', { selector: '#go' })])
    expect(ensureNavigationAnchor(noOrigin)).toBe(noOrigin)

    const anchoredOnce = ensureNavigationAnchor(anchored([node('event-click', {})], 'https://x.test/'))
    expect(ensureNavigationAnchor(anchoredOnce)).toBe(anchoredOnce)
  })

  it('links the trigger when the graph has no edges at all', () => {
    const wf = anchored([node('forms', { selector: '#q' })], 'https://x.test/a')
    const trigger = wf.drawflow.nodes[0]!
    const head = wf.drawflow.nodes[1]!
    const out = ensureNavigationAnchor(wf)
    expect(out.drawflow.edges.some((e) => e.source === trigger.id && e.target === 'page-anchor')).toBe(true)
    expect(out.drawflow.edges.some((e) => e.source === 'page-anchor' && e.target === head.id)).toBe(true)
  })

  it('takes the URL from the argument, and refuses a non-http origin', () => {
    const wf = anchored([node('event-click', {})], 'file:///tmp/page.html')
    expect(ensureNavigationAnchor(wf)).toBe(wf)
    const out = ensureNavigationAnchor(wf, 'https://given.example/')
    expect(out.drawflow.nodes[1]?.data['url']).toBe('https://given.example/')
  })
})

describe('persistDefaultRetries', () => {
  it('arms a retry on page steps only', () => {
    const wf = workflowOf([
      node('event-click', { selector: '#go' }),
      node('get-text', { selector: '.out' }),
      node('set-variable', { variableName: 'x' }),
      node('loop-data', { dataKey: 'rows' }),
      node('delay', { time: 500 }),
    ])
    const out = persistDefaultRetries(wf)
    const policy = (blockId: string) =>
      out.drawflow.nodes.find((n) => n.data['blockId'] === blockId)!.data['onError']

    expect(policy('event-click')).toEqual({
      enable: true,
      toDo: 'retry',
      retryTimes: 2,
      retryInterval: 800,
    })
    expect(policy('get-text')).toBeTruthy()
    // A retry of a variable step fixes nothing and a retry of a loop re-runs
    // its whole body; the trigger is not a step at all.
    expect(policy('set-variable')).toBeUndefined()
    expect(policy('loop-data')).toBeUndefined()
    expect(policy('delay')).toBeUndefined()
    expect(wf.drawflow.nodes[1]!.data['onError']).toBeUndefined()
  })

  it('never re-fires a step that submits, sends or logs in', () => {
    const wf = workflowOf([
      node('forms', { selector: '#q', action: 'submit' }),
      node('event-click', { selector: '#buy', description: '提交订单' }),
      node('webhook', { url: 'https://hook.test' }),
    ])
    const out = persistDefaultRetries(wf)
    for (const blockId of ['forms', 'event-click', 'webhook']) {
      expect(out.drawflow.nodes.find((n) => n.data['blockId'] === blockId)!.data['onError']).toBeUndefined()
    }
  })

  it('respects an error policy the node already has', () => {
    const wf = workflowOf([
      node('event-click', { selector: '#go', onError: { enable: true, toDo: 'fallback' } }),
    ])
    const out = persistDefaultRetries(wf)
    expect(out.drawflow.nodes[1]!.data['onError']).toEqual({ enable: true, toDo: 'fallback' })
    expect(out).toBe(wf)
  })

  it('is idempotent and keeps the graph structure', () => {
    const wf = workflowOf([node('event-click', { selector: '#go' })])
    const once = persistDefaultRetries(wf)
    expect(persistDefaultRetries(once)).toBe(once)
    expect(once.drawflow.nodes.map((n) => n.id)).toEqual(wf.drawflow.nodes.map((n) => n.id))
  })
})

describe('hardenWorkflowSelectors', () => {
  beforeEach(() => {
    vi.mocked(resolveAutomationTab).mockResolvedValue({
      id: 1,
      url: 'https://example.com/',
    } as chrome.tabs.Tab)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubCounts(counts: number[]): void {
    vi.stubGlobal('chrome', {
      scripting: { executeScript: vi.fn(async () => [{ result: counts }]) },
      tabs: { get: vi.fn() },
    })
  }

  it('re-picks the exact-match candidate and stamps selectorVerified', async () => {
    // Candidates for the node: ['#gone', '.card']. The first matches nothing,
    // the second matches exactly one.
    stubCounts([0, 1])
    const wf = workflowOf([
      node('event-click', {
        selector: '#gone',
        target: { primary: { how: 'css', value: '.card' } },
      }),
    ])
    const out = await hardenWorkflowSelectors(wf)
    const click = out.drawflow.nodes[1]!
    expect(click.data['selector']).toBe('.card')
    expect(click.data['selectorVerified']).toBe(true)
  })

  it('leaves the graph untouched when the page cannot be probed', async () => {
    vi.mocked(resolveAutomationTab).mockResolvedValue(undefined)
    const wf = workflowOf([node('event-click', { selector: '#gone' })])
    const out = await hardenWorkflowSelectors(wf)
    expect(out).toBe(wf)
    expect(wf.drawflow.nodes[1]!.data['selector']).toBe('#gone')
  })

  it('clears the selector when no candidate matches, keeping the rich target', async () => {
    stubCounts([0, 0])
    const rich = { primary: { how: 'role', value: 'Buy', role: 'button' } }
    const wf = workflowOf([node('event-click', { selector: '#gone', target: rich })])
    const out = await hardenWorkflowSelectors(wf)
    const click = out.drawflow.nodes[1]!
    expect(click.data['selector']).toBe('')
    expect(click.data['target']).toEqual(rich)
    expect(click.data['selectorVerified']).toBeUndefined()
  })
})
