/**
 * `conditions` block routing: the FIRST path whose tree holds wins (later paths
 * are not evaluated), and when none holds the run continues on the fallback
 * output. A matched-but-unwired path does not fall through to a sibling.
 */
import { describe, expect, it } from 'vitest'

import { runWorkflow } from '../src/background/workflow-engine/engine'
import { EXECUTORS } from '../src/background/workflow-engine/executors'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data,
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}-${handle ?? ''}->${target}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

function withBody(order: string[]) {
  return {
    ...EXECUTORS,
    mark: async () => {
      order.push('body')
      return null
    },
  }
}

/** A path whose tree is `left eq right` (no page access needed). */
function eqPath(id: string, name: string, left: string, right: string) {
  return {
    id,
    name,
    conditions: [
      {
        id: `g-${id}`,
        conditions: [
          {
            id: `r-${id}`,
            items: [
              { id: `${id}-l`, category: 'value', type: 'value', data: { value: left } },
              { id: `${id}-c`, category: 'compare', type: 'eq' },
              { id: `${id}-r`, category: 'value', type: 'value', data: { value: right } },
            ],
          },
        ],
      },
    ],
  }
}

const GATE = (paths: unknown): WorkflowNode =>
  node('gate', 'conditions', { blockId: 'conditions', paths })

describe('conditions block · ordered path routing', () => {
  it('runs the first matching path and stops', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [
          GATE([eqPath('p1', 'A', 'a', 'a'), eqPath('p2', 'B', 'b', 'b')]),
          node('a', 'mark'),
          node('b', 'mark'),
        ],
        [edge('gate', 'a', 'conditions-output-p1'), edge('gate', 'b', 'conditions-output-p2')],
      ),
      { executors: withBody(order) },
    )
    expect(order).toEqual(['body'])
    expect(result.completedNodeIds).toEqual(['gate', 'a'])
  })

  it('skips a non-matching first path and takes the next', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [
          GATE([eqPath('p1', 'A', 'a', 'zzz'), eqPath('p2', 'B', 'b', 'b')]),
          node('a', 'mark'),
          node('b', 'mark'),
        ],
        [edge('gate', 'a', 'conditions-output-p1'), edge('gate', 'b', 'conditions-output-p2')],
      ),
      { executors: withBody(order) },
    )
    expect(result.completedNodeIds).toEqual(['gate', 'b'])
  })

  it('takes the fallback when no path holds', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [GATE([eqPath('p1', 'A', 'a', 'zzz')]), node('fb', 'mark'), node('a', 'mark')],
        [edge('gate', 'a', 'conditions-output-p1'), edge('gate', 'fb', 'conditions-output-none')],
      ),
      { executors: withBody(order) },
    )
    expect(result.completedNodeIds).toEqual(['gate', 'fb'])
  })

  it('does not fall through to a sibling when the matched path is unwired', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [GATE([eqPath('p1', 'A', 'a', 'a')]), node('other', 'mark')],
        [edge('gate', 'other', 'conditions-output-unwired')],
      ),
      { executors: withBody(order) },
    )
    // The matched path has no edge, so the run stops at the gate — it must NOT
    // silently continue into the other wired branch.
    expect(result.completedNodeIds).toEqual(['gate'])
  })

  it('takes the fallback when every path is empty (unconfigured)', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [GATE([{ id: 'p1', name: 'A', conditions: [] }]), node('fb', 'mark')],
        [edge('gate', 'fb', 'conditions-output-none')],
      ),
      { executors: withBody(order) },
    )
    expect(result.completedNodeIds).toEqual(['gate', 'fb'])
  })
})
