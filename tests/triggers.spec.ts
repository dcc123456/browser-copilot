import { describe, expect, it } from 'vitest'
import {
  LEGACY_TRIGGER_SPEC_ID,
  TRIGGER_KIND_FIELDS,
  isWorkflowTriggerAlarm,
  newTriggerSpec,
  normalizeTriggers,
  parseTriggerAlarmName,
  primaryTrigger,
  workflowTriggerAlarmName,
  writeTriggers,
  type WorkflowTriggerSpec,
} from '../src/lib/workflow/triggers'
import { triggerFromNodes } from '../src/lib/workflow/migrate'
import type { WorkflowNode } from '../src/lib/workflow/types'

function intervalSpec(id: string): WorkflowTriggerSpec {
  return { id, type: 'interval', data: { interval: 30, delay: 2 } }
}

describe('legacy flat trigger normalization', () => {
  it('folds a flat trigger node into one primary spec', () => {
    const specs = normalizeTriggers({
      blockId: 'trigger',
      type: 'interval',
      interval: 15,
      delay: 3,
      enabled: false,
    })
    expect(specs).toEqual([
      {
        id: LEGACY_TRIGGER_SPEC_ID,
        type: 'interval',
        enabled: false,
        data: { interval: 15, delay: 3 },
      },
    ])
  })

  it('falls back to the top-level mirror for kind fields it alone carries', () => {
    expect(
      normalizeTriggers({ type: 'visit-web' }, { type: 'visit-web', urlPattern: 'a.com/*' })[0],
    ).toMatchObject({ type: 'visit-web', data: { url: 'a.com/*' } })
    expect(
      normalizeTriggers({ type: 'context-menu' }, { type: 'context-menu', menuItemId: 'share' })[0],
    ).toMatchObject({ data: { contextMenuName: 'share' } })
  })

  it('defaults to a manual trigger when neither the node nor the mirror says otherwise', () => {
    const [spec] = normalizeTriggers(undefined)
    expect(spec).toMatchObject({ id: LEGACY_TRIGGER_SPEC_ID, type: 'manual', enabled: true })
  })
})

describe('multi-trigger round trip', () => {
  it('writes the list and mirrors only the primary onto the flat fields', () => {
    const nodeData = {
      blockId: 'trigger',
      type: 'interval',
      interval: 5,
      delay: 1,
      description: 'x',
    }
    const next = writeTriggers(nodeData, [
      { id: 'a', type: 'visit-web', data: { url: 'https://example.com', isUrlRegex: false } },
      intervalSpec('b'),
    ])

    expect(next['type']).toBe('visit-web')
    expect(next['url']).toBe('https://example.com')
    // The secondary kind's fields never leak onto the flat mirror.
    expect(next['interval']).toBeUndefined()
    expect(next['delay']).toBeUndefined()
    expect(next['description']).toBe('x')
    expect(next['triggers']).toHaveLength(2)

    const read = normalizeTriggers(next)
    expect(read.map((spec) => [spec.id, spec.type])).toEqual([
      ['a', 'visit-web'],
      ['b', 'interval'],
    ])
    expect(read[1]?.data).toEqual({ interval: 30, delay: 2 })
    expect(primaryTrigger(read).id).toBe('a')
  })

  it('clears every kind field the previous primary owned', () => {
    const previous = {
      blockId: 'trigger',
      type: 'keyboard-shortcut',
      shortcut: 'Ctrl+Shift+K',
      activeInInput: true,
    }
    const next = writeTriggers(previous, [{ id: 'a', type: 'manual', data: {} }])
    for (const field of TRIGGER_KIND_FIELDS['keyboard-shortcut']) {
      expect(next[field]).toBeUndefined()
    }
    expect(next['type']).toBe('manual')
  })

  it('keeps a disabled spec disabled through the round trip', () => {
    const specs: WorkflowTriggerSpec[] = [
      { id: 'a', type: 'manual', enabled: true, data: {} },
      { id: 'b', type: 'interval', enabled: false, data: { interval: 60, delay: 5 } },
    ]
    const [first, second] = normalizeTriggers(writeTriggers({}, specs))
    expect(first?.enabled).toBe(true)
    expect(second?.enabled).toBe(false)
  })

  it('never re-keys a spec that was stored without an id', () => {
    const nodeData = {
      triggers: [
        { type: 'manual', data: {} },
        { type: 'interval', data: {} },
      ],
    }
    const once = normalizeTriggers(nodeData)
    const twice = normalizeTriggers(nodeData)
    expect(once.map((spec) => spec.id)).toEqual(['spec-0', 'spec-1'])
    expect(twice.map((spec) => spec.id)).toEqual(once.map((spec) => spec.id))
  })

  it('strips the alarm separator from imported ids', () => {
    const [spec] = normalizeTriggers({ triggers: [{ id: 'a:b', type: 'manual', data: {} }] })
    expect(spec?.id).toBe('a-b')
  })
})

describe('per-type defaults', () => {
  it('seeds every offered kind with usable defaults', () => {
    expect(newTriggerSpec('interval').data).toEqual({ interval: 60, delay: 5 })
    expect(newTriggerSpec('visit-web').data).toEqual({ url: '', isUrlRegex: false })
    expect(newTriggerSpec('keyboard-shortcut').data).toEqual({ shortcut: '', activeInInput: false })
    expect(newTriggerSpec('context-menu').data).toEqual({ contextMenuName: '', contextTypes: [] })
    expect(newTriggerSpec('element-change').data).toHaveProperty('observeElement')
    expect(newTriggerSpec('manual').data).toEqual({})
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTriggerSpec('manual').id))
    expect(ids.size).toBe(20)
  })
})

describe('the primary mirror', () => {
  it('drives triggerFromNodes, keeping the workflows-list chip and Runner working', () => {
    const node = {
      id: 't',
      label: 'trigger',
      position: { x: 0, y: 0 },
      data: writeTriggers({ blockId: 'trigger' }, [
        { id: 'a', type: 'visit-web', data: { url: 'https://example.com/*' } },
        intervalSpec('b'),
      ]),
    } as WorkflowNode
    expect(triggerFromNodes([node])).toMatchObject({
      type: 'visit-web',
      enabled: true,
      urlPattern: 'https://example.com/*',
    })
  })
})

describe('alarm names', () => {
  it('builds legacy and per-spec names', () => {
    expect(workflowTriggerAlarmName('wf')).toBe('wftrigger:wf')
    expect(workflowTriggerAlarmName('wf', 'a')).toBe('wftrigger:wf:a')
    expect(isWorkflowTriggerAlarm('wftrigger:wf:a')).toBe(true)
    expect(isWorkflowTriggerAlarm('loop-progress')).toBe(false)
  })

  it('parses both shapes', () => {
    expect(parseTriggerAlarmName('wftrigger:wf')).toEqual({ workflowId: 'wf' })
    expect(parseTriggerAlarmName('wftrigger:wf:a')).toEqual({ workflowId: 'wf', triggerId: 'a' })
    expect(parseTriggerAlarmName('other:wf')).toBeNull()
    expect(parseTriggerAlarmName('wftrigger:')).toBeNull()
    expect(parseTriggerAlarmName('wftrigger:wf:')).toEqual({ workflowId: 'wf' })
  })
})
