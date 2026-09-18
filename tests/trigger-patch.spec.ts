import { describe, expect, it } from 'vitest'
import {
  applyTriggerSelection,
  triggerSelectionOf,
  TRIGGER_KIND_FIELDS,
} from '../src/lib/workflow/trigger-patch'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function edge(source: string, target: string): WorkflowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: 'trigger-output-1',
    targetHandle: 'event-click-input-1',
  }
}

function workflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
  trigger?: Workflow['trigger'],
): Workflow {
  return {
    id: 'w1',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges },
    ...(trigger ? { trigger } : {}),
  }
}

const withTrigger = (type = 'manual', data: Record<string, unknown> = {}) =>
  workflow(
    [node('t', 'trigger', { type, ...data }), node('c', 'event-click', { selector: '#a' })],
    [edge('t', 'c')],
  )

/**
 * The trigger lives in two places — the graph block (which `effectiveTriggerKind`
 * and `workflowAutoTrigger` actually read) and the denormalized top-level field.
 * Nothing syncs them automatically, so an `interval` workflow whose top-level
 * mirror still says `manual` is simply never armed.
 */
describe('applyTriggerSelection', () => {
  it('writes the kind onto the trigger node AND the top-level mirror', () => {
    const out = applyTriggerSelection(withTrigger(), { type: 'interval', params: { interval: 30 } })

    const node_ = out.drawflow.nodes.find((n) => n.id === 't')!
    expect(node_.data['type']).toBe('interval')
    expect(node_.data['interval']).toBe(30)
    expect(out.trigger?.type).toBe('interval')
  })

  it('denormalizes the two kinds that have a top-level field', () => {
    const visit = applyTriggerSelection(withTrigger(), {
      type: 'visit-web',
      params: { url: 'https://x.test/*' },
    })
    expect(visit.trigger?.urlPattern).toBe('https://x.test/*')

    const menu = applyTriggerSelection(withTrigger(), {
      type: 'context-menu',
      params: { contextMenuName: 'Summarise page' },
    })
    expect(menu.trigger?.menuItemId).toBe('Summarise page')
  })

  it('clears the previous kind\u2019s fields when the kind changes', () => {
    // A leftover `url` on an interval trigger is exactly what makes a reader
    // (or the editor) believe the wrong trigger is configured.
    const out = applyTriggerSelection(withTrigger('visit-web', { url: 'https://old.test' }), {
      type: 'interval',
      params: { interval: 15 },
    })
    const node_ = out.drawflow.nodes.find((n) => n.id === 't')!
    expect(node_.data['url']).toBeUndefined()
    expect(node_.data['type']).toBe('interval')
    expect(out.trigger?.urlPattern).toBeUndefined()
  })

  it('keeps `time`, which the two time-of-day kinds share', () => {
    const out = applyTriggerSelection(withTrigger('specific-day', { days: [1], time: '09:30' }), {
      type: 'date',
      params: { date: '2026-10-01', time: '09:30' },
    })
    const node_ = out.drawflow.nodes.find((n) => n.id === 't')!
    expect(node_.data['time']).toBe('09:30')
    expect(node_.data['date']).toBe('2026-10-01')
    // `days` belongs to the other kind and must be gone.
    expect(node_.data['days']).toBeUndefined()
  })

  it('preserves `enabled` and `description` on the node', () => {
    // A real draft node carries `enabled: true` (see `ensureTriggerHead`).
    const out = applyTriggerSelection(
      withTrigger('manual', { enabled: true, description: 'run me' }),
      { type: 'on-startup', params: {} },
    )
    const node_ = out.drawflow.nodes.find((n) => n.id === 't')!
    expect(node_.data['description']).toBe('run me')
    expect(node_.data['enabled']).toBe(true)
  })

  it('does not invent an `enabled` flag the node never had', () => {
    const out = applyTriggerSelection(withTrigger(), { type: 'on-startup', params: {} })
    expect(out.drawflow.nodes.find((n) => n.id === 't')!.data['enabled']).toBeUndefined()
  })

  it('does not silently re-arm a trigger the editor switched off', () => {
    const out = applyTriggerSelection(withTrigger('manual', { enabled: false }), {
      type: 'on-startup',
      params: {},
    })
    expect(out.drawflow.nodes.find((n) => n.id === 't')!.data['enabled']).toBe(false)
  })

  it('prepends a trigger node when the graph has none', () => {
    const bare = workflow([node('c', 'event-click', { selector: '#a' })])
    const out = applyTriggerSelection(bare, { type: 'manual', params: {} })

    const trigger = out.drawflow.nodes.find((n) => n.label === 'trigger')!
    expect(trigger).toBeDefined()
    // It becomes the entry point, wired to the node that had no incoming edge.
    const fromTrigger = out.drawflow.edges.filter((e) => e.source === trigger.id)
    expect(fromTrigger).toHaveLength(1)
    expect(fromTrigger[0]!.target).toBe('c')
    expect(out.trigger?.type).toBe('manual')
  })

  it('does not add a second trigger node', () => {
    const out = applyTriggerSelection(withTrigger(), { type: 'manual', params: {} })
    expect(out.drawflow.nodes.filter((n) => n.label === 'trigger')).toHaveLength(1)
  })

  it('never mutates the workflow it was given', () => {
    const base = withTrigger('manual')
    const before = JSON.stringify(base)
    applyTriggerSelection(base, { type: 'interval', params: { interval: 5 } })
    expect(JSON.stringify(base)).toBe(before)
  })

  it('is idempotent', () => {
    const sel = { type: 'specific-day' as const, params: { days: [1, 3], time: '08:00' } }
    const once = applyTriggerSelection(withTrigger(), sel)
    const twice = applyTriggerSelection(once, sel)
    expect(twice.drawflow.nodes).toEqual(once.drawflow.nodes)
    expect(twice.trigger).toEqual(once.trigger)
  })

  it('declares fields for every offered kind', () => {
    for (const fields of Object.values(TRIGGER_KIND_FIELDS)) {
      expect(Array.isArray(fields)).toBe(true)
    }
  })
})

describe('triggerSelectionOf', () => {
  it('reads the kind and its params back off the node', () => {
    const wf = withTrigger('keyboard-shortcut', { shortcut: 'Ctrl+Shift+E' })
    expect(triggerSelectionOf(wf)).toEqual({
      type: 'keyboard-shortcut',
      params: { shortcut: 'Ctrl+Shift+E' },
    })
  })

  it('falls back to the top-level mirror for the denormalized kinds', () => {
    const wf = workflow([node('t', 'trigger', { type: 'visit-web' })], [], {
      type: 'visit-web',
      urlPattern: 'https://x.test/*',
    })
    expect(triggerSelectionOf(wf).params['url']).toBe('https://x.test/*')
  })

  it('reads a kind the build does not offer as manual', () => {
    // `scheduled` (cron) is not pickable; showing it as-is would let the card
    // save a workflow that silently never fires.
    expect(triggerSelectionOf(withTrigger('scheduled')).type).toBe('manual')
    expect(triggerSelectionOf(workflow([])).type).toBe('manual')
  })

  it('round-trips the nested element-change payload', () => {
    // The one kind whose parameters are nested: the picker writes the whole
    // `observeElement` object, and the observer reads it back unchanged.
    const observeElement = {
      selector: '#feed',
      matchPattern: 'https://x.test/*',
      targetOptions: { subtree: false, childList: true, attributes: false, characterData: false },
    }
    const sel = { type: 'element-change' as const, params: { observeElement } }
    const patched = applyTriggerSelection(withTrigger(), sel)
    expect(triggerSelectionOf(patched)).toEqual(sel)
    expect(patched.trigger).toEqual({ type: 'element-change', enabled: true })
  })

  it('clears the other kinds\u2019 fields when switching to element-change', () => {
    // A leftover `url` on an element-change node would make a reader believe
    // the wrong trigger is configured.
    const visited = applyTriggerSelection(withTrigger(), {
      type: 'visit-web',
      params: { url: 'https://x.test/*' },
    })
    const node = (wf: ReturnType<typeof withTrigger>) =>
      wf.drawflow.nodes.find((n) => n.data?.['blockId'] === 'trigger')?.data ?? {}
    expect(node(visited)['url']).toBe('https://x.test/*')
    const swapped = applyTriggerSelection(visited, {
      type: 'element-change',
      params: { observeElement: { selector: '#a' } },
    })
    expect(node(swapped)['url']).toBeUndefined()
    expect(node(swapped)['observeElement']).toEqual({ selector: '#a' })
  })

  it('round-trips through applyTriggerSelection', () => {
    const sel = { type: 'interval' as const, params: { interval: 45 } }
    expect(triggerSelectionOf(applyTriggerSelection(withTrigger(), sel))).toEqual(sel)
  })
})
