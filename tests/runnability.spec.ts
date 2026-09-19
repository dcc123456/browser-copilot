/**
 * Save-time runnability: persisted element waits, the page-anchor predicate,
 * and the save-time selector-hardening pass.
 *
 * The generation session proves each step works; the replay is what fails when
 * pages render late or the graph never opens a page of its own. These tests
 * pin the three guards a regression would silently undo:
 *
 *  1. `persistDefaultWaits` — waits persisted ON the graph at save time,
 *     idempotently, without touching the graph's structure.
 *  2. `unanchoredElementStart` — a graph whose first element action has no
 *     page-opening block before it replays only on the generation-time page.
 *  3. `hardenWorkflowSelectors` — one batched probe re-picks every recorded
 *     selector, and a refused probe leaves the graph untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistDefaultWaits, unanchoredElementStart } from '../src/lib/workflow/runnability'
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
