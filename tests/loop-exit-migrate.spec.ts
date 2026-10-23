import { describe, it, expect } from 'vitest'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, ...data },
})

const edge = (
  id: string,
  source: string,
  target: string,
  sourceHandle: string,
  targetHandle: string,
): WorkflowEdge => ({ id, source, target, sourceHandle, targetHandle })

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'loops',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges, position: { x: 0, y: 0 }, zoom: 1 },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const breakpointsOf = (wf: Workflow): WorkflowNode[] =>
  wf.drawflow.nodes.filter((n) => n.data['blockId'] === 'loop-breakpoint')

/** trigger → loop → body → loop (folded cycle), loop output-2 → after. */
function legacyFold(loopBlock: 'loop-data' | 'loop-elements' = 'loop-data'): Workflow {
  const wf = workflow(
    [
      node('t', 'trigger', { type: 'manual' }),
      node('loop', loopBlock, { loopData: '[1,2]', loopId: '' }),
      node('body', 'event-click', { selector: 'a' }),
      node('after', 'delay', { delay: 10 }),
    ],
    [
      edge('e-t', 't', 'loop', 'trigger-output-1', `${loopBlock}-input-1`),
      edge('e-body', 'loop', 'body', `${loopBlock}-output-1`, 'event-click-input-1'),
      edge('e-back', 'body', 'loop', 'event-click-output-1', `${loopBlock}-input-1`),
      edge('e-end', 'loop', 'after', `${loopBlock}-output-2`, 'delay-input-1'),
    ],
  )
  // A one-row layout, so placement can be asserted like the real editor.
  const coords: Record<string, [number, number]> = {
    t: [0, 0],
    loop: [220, 0],
    body: [440, 0],
    after: [660, 0],
  }
  for (const item of wf.drawflow.nodes) {
    item.position = { x: coords[item.id]![0], y: coords[item.id]![1] }
  }
  return wf
}

describe('legacy loop output-2 → loop-breakpoint migration', () => {
  it('drops the drawn cycle and routes it through an inserted breakpoint', () => {
    const out = migrateWorkflow(legacyFold())
    const [bp] = breakpointsOf(out)
    expect(bp).toBeDefined()

    // loop → body, body → breakpoint, breakpoint → after; no edge back into the loop.
    expect(out.drawflow.edges.some((e) => e.target === 'loop' && e.id !== 'e-t')).toBe(false)
    const intoBody = out.drawflow.edges.find((e) => e.source === 'loop')
    expect(intoBody?.sourceHandle).toBe('loop-data-output-1')
    const intoBp = out.drawflow.edges.find((e) => e.source === 'body' && e.target === bp!.id)
    expect(intoBp?.sourceHandle).toBe('event-click-output-1')
    expect(intoBp?.targetHandle).toBe('loop-breakpoint-input-1')

    const after = out.drawflow.edges.find((e) => e.id === 'e-end')
    expect(after).toMatchObject({
      source: bp!.id,
      sourceHandle: 'loop-breakpoint-output-1',
      target: 'after',
    })
    expect(
      out.drawflow.edges.some(
        (e) => e.source === 'loop' && (e.sourceHandle ?? '').endsWith('output-2'),
      ),
    ).toBe(false)
  })

  it('places the inserted breakpoint right after the body in array order', () => {
    const out = migrateWorkflow(legacyFold())
    const ids = out.drawflow.nodes.map((n) => n.id)
    expect(ids.indexOf(breakpointsOf(out)[0]!.id)).toBe(ids.indexOf('body') + 1)
  })

  it('places the inserted breakpoint clear of the existing nodes', () => {
    const out = migrateWorkflow(legacyFold())
    const [bp] = breakpointsOf(out)
    for (const other of out.drawflow.nodes) {
      if (other.id === bp!.id) continue
      const overlaps =
        Math.abs(other.position.x - bp!.position.x) < 240 &&
        Math.abs(other.position.y - bp!.position.y) < 80
      expect(overlaps, `${other.id} overlaps the breakpoint`).toBe(false)
    }
  })

  it('carries the loop id onto the inserted breakpoint', () => {
    const wf = legacyFold()
    wf.drawflow.nodes[1]!.data['loopId'] = 'outer'
    const [bp] = breakpointsOf(migrateWorkflow(wf))
    expect(bp?.data['loopId']).toBe('outer')
    expect(bp?.data['clearLoop']).toBe(false)
  })

  it('reuses a breakpoint already parked at the body tail', () => {
    const wf = workflow(
      [
        node('t', 'trigger', { type: 'manual' }),
        node('loop', 'loop-data', { loopId: '' }),
        node('body', 'event-click'),
        node('bp', 'loop-breakpoint', { loopId: '' }),
        node('after', 'delay'),
      ],
      [
        edge('e-t', 't', 'loop', 'trigger-output-1', 'loop-data-input-1'),
        edge('e-body', 'loop', 'body', 'loop-data-output-1', 'event-click-input-1'),
        edge('e-bp', 'body', 'bp', 'event-click-output-1', 'loop-breakpoint-input-1'),
        edge('e-end', 'loop', 'after', 'loop-data-output-2', 'delay-input-1'),
      ],
    )
    const out = migrateWorkflow(wf)
    expect(breakpointsOf(out)).toHaveLength(1)
    expect(out.drawflow.nodes.some((n) => n.id.startsWith('loop-loop-breakpoint'))).toBe(false)
    expect(out.drawflow.edges.find((e) => e.id === 'e-end')).toMatchObject({
      source: 'bp',
      sourceHandle: 'loop-breakpoint-output-1',
    })
  })

  it('keeps an explicit continuation from the tail breakpoint and drops the old exit', () => {
    const wf = workflow(
      [
        node('t', 'trigger', { type: 'manual' }),
        node('loop', 'loop-data', { loopId: '' }),
        node('body', 'event-click'),
        node('bp', 'loop-breakpoint', { loopId: '' }),
        node('after', 'delay'),
        node('other', 'delay'),
      ],
      [
        edge('e-t', 't', 'loop', 'trigger-output-1', 'loop-data-input-1'),
        edge('e-body', 'loop', 'body', 'loop-data-output-1', 'event-click-input-1'),
        edge('e-bp', 'body', 'bp', 'event-click-output-1', 'loop-breakpoint-input-1'),
        edge('e-bp-out', 'bp', 'other', 'loop-breakpoint-output-1', 'delay-input-1'),
        edge('e-end', 'loop', 'after', 'loop-data-output-2', 'delay-input-1'),
      ],
    )
    const out = migrateWorkflow(wf)
    expect(out.drawflow.edges.some((e) => e.id === 'e-end')).toBe(false)
    expect(out.drawflow.edges.find((e) => e.id === 'e-bp-out')?.target).toBe('other')
  })

  it('makes a bodyless loop run straight into the breakpoint', () => {
    const wf = workflow(
      [node('loop', 'loop-data', { loopId: '' }), node('after', 'delay')],
      [edge('e-end', 'loop', 'after', 'loop-data-output-2', 'delay-input-1')],
    )
    const out = migrateWorkflow(wf)
    const bp = breakpointsOf(out)[0]!
    expect(
      out.drawflow.edges.find((e) => e.source === 'loop' && e.target === bp.id)?.sourceHandle,
    ).toBe('loop-data-output-1')
    expect(out.drawflow.edges.find((e) => e.id === 'e-end')?.source).toBe(bp.id)
  })

  it('migrates loop-elements the same way, including a bare `end` handle', () => {
    const wf = legacyFold('loop-elements')
    const endEdge = wf.drawflow.edges.find((e) => e.id === 'e-end')!
    endEdge.sourceHandle = 'end'
    const out = migrateWorkflow(wf)
    const [bp] = breakpointsOf(out)
    expect(bp).toBeDefined()
    expect(out.drawflow.edges.find((e) => e.id === 'e-end')?.source).toBe(bp!.id)
  })

  it('is idempotent', () => {
    const once = migrateWorkflow(legacyFold())
    const twice = migrateWorkflow(once)
    expect(twice).toEqual(once)
    expect(twice.drawflow.nodes).toHaveLength(once.drawflow.nodes.length)
  })

  it('leaves a new-shape loop (breakpoint, no output-2) untouched', () => {
    const wf = workflow(
      [
        node('t', 'trigger', { type: 'manual' }),
        node('loop', 'loop-data', { loopId: '' }),
        node('body', 'event-click'),
        node('bp', 'loop-breakpoint', { loopId: '' }),
        node('after', 'delay'),
      ],
      [
        edge('e-t', 't', 'loop', 'trigger-output-1', 'loop-data-input-1'),
        edge('e-body', 'loop', 'body', 'loop-data-output-1', 'event-click-input-1'),
        edge('e-bp', 'body', 'bp', 'event-click-output-1', 'loop-breakpoint-input-1'),
        edge('e-after', 'bp', 'after', 'loop-breakpoint-output-1', 'delay-input-1'),
      ],
    )
    const out = migrateWorkflow(wf)
    expect(breakpointsOf(out)).toHaveLength(1)
    expect(out.drawflow.edges).toHaveLength(wf.drawflow.edges.length)
  })
})
