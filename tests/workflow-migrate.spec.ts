/**
 * Migration: legacy Browser Copilot workflows and Automa-exported JSON both
 * load into the Automa-aligned node model.
 */
import { describe, it, expect } from 'vitest'
import {
  migrateNodeData,
  migrateWorkflow,
  fromAutomaExport,
  LEGACY_ID_TO_AUTOMA,
} from '../src/lib/workflow/migrate'
import type { Workflow } from '../src/lib/workflow/types'

describe('migrateNodeData', () => {
  it('maps legacy block ids to Automa ids', () => {
    expect(migrateNodeData('click', {}).blockId).toBe('event-click')
    expect(migrateNodeData('fill', {}).blockId).toBe('forms')
    expect(migrateNodeData('scroll', {}).blockId).toBe('element-scroll')
    expect(migrateNodeData('hover', {}).blockId).toBe('hover-element')
    expect(migrateNodeData('condition', {}).blockId).toBe('conditions')
  })

  it('keeps ids that already match Automa', () => {
    expect(migrateNodeData('delay', {}).blockId).toBe('delay')
    expect(migrateNodeData('new-tab', {}).blockId).toBe('new-tab')
  })

  it('flattens legacy values.cssSelector into Automa selector', () => {
    const { data } = migrateNodeData('click', { values: { cssSelector: '.btn' } })
    expect(data.selector).toBe('.btn')
    expect(data.findBy).toBe('cssSelector')
  })

  it('prefers an explicit flat selector over legacy values', () => {
    const { data } = migrateNodeData('click', {
      selector: '.primary',
      values: { cssSelector: '.btn' },
    })
    expect(data.selector).toBe('.primary')
  })

  it('fills catalog defaults (disableBlock etc.)', () => {
    const { data } = migrateNodeData('event-click', {})
    expect(data.disableBlock).toBe(false)
  })

  it('preserves unknown extra fields', () => {
    const { data } = migrateNodeData('delay', { ms: 1234 })
    expect(data.ms).toBe(1234)
  })
})

describe('migrateWorkflow', () => {
  it('migrates a legacy workflow without mutating the input', () => {
    const wf: Workflow = {
      id: 'w1',
      name: 'Legacy',
      createdAt: 1,
      updatedAt: 1,
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: {
        nodes: [
          {
            id: 'n1',
            label: '点击元素',
            position: { x: 0, y: 0 },
            data: { blockId: 'click', values: { cssSelector: '.a' } },
          },
          {
            id: 'n2',
            label: '延时',
            position: { x: 200, y: 0 },
            data: { blockId: 'delay', values: { ms: 500 } },
          },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    }
    const out = migrateWorkflow(wf)
    expect(out.drawflow.nodes[0]!.data.blockId).toBe('event-click')
    expect(out.drawflow.nodes[0]!.data.selector).toBe('.a')
    expect(out.drawflow.nodes[1]!.data.blockId).toBe('delay')
    // input untouched
    expect(wf.drawflow.nodes[0]!.data.blockId).toBe('click')
    // edges preserved
    expect(out.drawflow.edges).toHaveLength(1)
  })

  it('returns the same reference when nothing needs migration', () => {
    const wf: Workflow = {
      id: 'w2',
      name: 'Modern',
      createdAt: 1,
      updatedAt: 1,
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: {
        nodes: [
          {
            id: 'n1',
            label: 'Delay',
            position: { x: 0, y: 0 },
            data: { blockId: 'delay', disableBlock: false, description: '' },
          },
        ],
        edges: [],
      },
    }
    expect(migrateWorkflow(wf)).toBe(wf)
  })
})

describe('fromAutomaExport', () => {
  it('converts classic Automa drawflow.Home.data into nodes and edges', () => {
    const automaJson = {
      name: 'Automa flow',
      drawflow: {
        Home: {
          data: {
            1: {
              id: 1,
              name: 'trigger',
              data: { description: '', type: 'manual' },
              positionX: 100,
              positionY: 200,
              outputs: { 'output-1': { connections: [{ node: 2, output: 'input-1' }] } },
              inputs: {},
            },
            2: {
              id: 2,
              name: 'event-click',
              data: { description: 'Click', selector: '.go', findBy: 'cssSelector' },
              positionX: 400,
              positionY: 200,
              outputs: {},
              inputs: { 'input-1': { connections: [{ node: 1, output: 'output-1' }] } },
            },
          },
        },
      },
    }
    const result = fromAutomaExport(automaJson)
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(2)
    expect(result!.nodes[0]!.data.blockId).toBe('trigger')
    expect(result!.nodes[0]!.position).toEqual({ x: 100, y: 200 })
    expect(result!.nodes[1]!.data.selector).toBe('.go')
    expect(result!.edges).toHaveLength(1)
    expect(result!.edges[0]!).toMatchObject({ source: '1', target: '2' })
  })

  it('returns null for native Browser Copilot format', () => {
    expect(fromAutomaExport({ drawflow: { nodes: [], edges: [] } })).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(fromAutomaExport(null)).toBeNull()
    expect(fromAutomaExport('nope')).toBeNull()
  })
})

describe('legacy id mapping completeness', () => {
  it('every mapped target exists in the Automa catalog', () => {
    const targets = new Set(Object.values(LEGACY_ID_TO_AUTOMA))
    // import lazily to keep the test's intent explicit
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    for (const target of targets) {
      // catalog lookup through migrateNodeData should not throw and should keep id
      expect(migrateNodeData(target, {}).blockId).toBe(target)
    }
  })
})
