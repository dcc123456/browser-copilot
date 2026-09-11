/**
 * triggerFromNodes: the editor denormalizes the trigger block into the
 * top-level `workflow.trigger` field on save, so the workflows list chip and
 * the background context-menu / visit-web listeners see the edited type.
 */
import { describe, it, expect } from 'vitest'
import { triggerFromNodes } from '../src/lib/workflow/migrate'
import type { WorkflowNode } from '../src/lib/workflow/types'

function triggerNode(data: Record<string, unknown>, label = 'trigger'): WorkflowNode {
  return {
    id: 'trig',
    label,
    position: { x: 0, y: 0 },
    data: { blockId: 'trigger', ...data },
  }
}

const OTHER_NODE: WorkflowNode = {
  id: 'click',
  label: 'Click',
  position: { x: 1, y: 0 },
  data: { blockId: 'event-click', type: 'manual' },
}

describe('triggerFromNodes', () => {
  it('returns undefined when the graph has no trigger node', () => {
    expect(triggerFromNodes([])).toBeUndefined()
    expect(triggerFromNodes([OTHER_NODE])).toBeUndefined()
  })

  it('defaults to the enabled manual trigger without a data.type', () => {
    expect(triggerFromNodes([triggerNode({})])).toEqual({ type: 'manual', enabled: true })
  })

  it('coerces unknown block types to manual', () => {
    expect(triggerFromNodes([triggerNode({ type: 'something-new' })])).toEqual({
      type: 'manual',
      enabled: true,
    })
  })

  it('passes the editor trigger kinds through verbatim', () => {
    for (const type of [
      'interval',
      'date',
      'specific-day',
      'on-startup',
      'keyboard-shortcut',
      'element-change',
    ]) {
      expect(triggerFromNodes([triggerNode({ type })])).toEqual({ type, enabled: true })
    }
  })

  it('maps visit-web url to urlPattern, ignoring empty values', () => {
    expect(triggerFromNodes([triggerNode({ type: 'visit-web', url: 'https://x.com/*' })])).toEqual({
      type: 'visit-web',
      enabled: true,
      urlPattern: 'https://x.com/*',
    })
    expect(triggerFromNodes([triggerNode({ type: 'visit-web' })])).toEqual({
      type: 'visit-web',
      enabled: true,
    })
    expect(triggerFromNodes([triggerNode({ type: 'visit-web', url: '' })])).toEqual({
      type: 'visit-web',
      enabled: true,
    })
  })

  it('maps context-menu name to menuItemId', () => {
    expect(
      triggerFromNodes([triggerNode({ type: 'context-menu', contextMenuName: 'Run it' })]),
    ).toEqual({
      type: 'context-menu',
      enabled: true,
      menuItemId: 'Run it',
    })
    expect(triggerFromNodes([triggerNode({ type: 'context-menu' })])).toEqual({
      type: 'context-menu',
      enabled: true,
    })
  })

  it('does not leak visit-web fields onto other trigger kinds', () => {
    expect(
      triggerFromNodes([triggerNode({ type: 'manual', url: 'https://x.com/*' })]),
    ).toEqual({ type: 'manual', enabled: true })
  })

  it('finds legacy trigger nodes by label when blockId is missing', () => {
    const legacy: WorkflowNode = {
      id: 'trig',
      label: 'trigger',
      position: { x: 0, y: 0 },
      data: { type: 'on-startup' },
    }
    expect(triggerFromNodes([legacy])).toEqual({ type: 'on-startup', enabled: true })
  })

  it('uses the first trigger node even when other blocks precede it', () => {
    expect(triggerFromNodes([OTHER_NODE, triggerNode({ type: 'interval' })])).toEqual({
      type: 'interval',
      enabled: true,
    })
  })
})
