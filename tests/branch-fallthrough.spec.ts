/**
 * A branch block must not fall through into its OTHER branch.
 *
 * `element-exists` with only the "exists" port wired used to run that branch even
 * when the element was absent, and `conditions` with only the "true" port wired
 * ran it when the condition was false. Two layers combined to make it happen: the
 * executor returned `outputs[taken] ?? ctx.defaultNext`, and the engine resolved
 * `resolver ?? defaultNext`, where `defaultNext` is simply the node's FIRST
 * out-edge — which for a one-branch wiring IS the other branch's target.
 *
 * An unlabelled out-edge (the pass-through shape older graphs use) must keep
 * continuing regardless of the verdict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runWorkflow } from '../src/background/workflow-engine/engine'
import { EXECUTORS } from '../src/background/workflow-engine/executors'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, elementExists: vi.fn(async () => 0) }
})

import { elementExists } from '../src/background/driver'

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data,
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}`,
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

/** The real branch executors, plus a body node that records that it ran. */
function withBody(order: string[]) {
  return {
    ...EXECUTORS,
    mark: async () => {
      order.push('body')
      return null
    },
  }
}

/** `score=3` against `score equals 10` — false without touching the page. */
const FALSE_CONDITIONS = {
  conditions: [{ conditions: [{ name: 'score', compare: 'eq', value: '10' }] }],
}

describe('element-exists branch wiring', () => {
  beforeEach(() => {
    vi.mocked(elementExists).mockResolvedValue(0)
  })

  it('does not run the exists branch when the element is absent', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [node('gate', 'element-exists', { selector: '#maybe' }), node('body', 'mark')],
        // Only the "exists" port is wired — the shape the operator guide
        // recommends for a step that may be skipped.
        [edge('gate', 'body', 'gate-output-1')],
      ),
      { executors: withBody(order) },
    )

    expect(order).toEqual([])
    expect(result.completedNodeIds).toEqual(['gate'])
    expect(result.outcome).toBe('ok')
  })

  it('runs the exists branch when the element is there', async () => {
    vi.mocked(elementExists).mockResolvedValue(2)
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [node('gate', 'element-exists', { selector: '#maybe' }), node('body', 'mark')],
        [edge('gate', 'body', 'gate-output-1')],
      ),
      { executors: withBody(order) },
    )

    expect(order).toEqual(['body'])
    expect(result.completedNodeIds).toEqual(['gate', 'body'])
  })

  it('still honours the notExists port when the element is absent', async () => {
    const order: string[] = []
    await runWorkflow(
      makeWorkflow(
        [node('gate', 'element-exists', { selector: '#maybe' }), node('body', 'mark')],
        [edge('gate', 'body', 'gate-output-2')],
      ),
      { executors: withBody(order) },
    )

    expect(order).toEqual(['body'])
  })

  it('keeps an unlabelled out-edge as a pass-through', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [node('gate', 'element-exists', { selector: '#maybe' }), node('body', 'mark')],
        [edge('gate', 'body')],
      ),
      { executors: withBody(order) },
    )

    expect(order).toEqual(['body'])
    expect(result.outcome).toBe('ok')
  })
})

describe('conditions branch wiring', () => {
  it('does not run the true branch when the condition is false', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [node('gate', 'conditions', FALSE_CONDITIONS), node('body', 'mark')],
        [edge('gate', 'body', 'gate-output-1')],
      ),
      { executors: withBody(order), variables: { score: '3' } },
    )

    expect(order).toEqual([])
    expect(result.completedNodeIds).toEqual(['gate'])
  })

  it('runs the true branch when the condition holds', async () => {
    const order: string[] = []
    const result = await runWorkflow(
      makeWorkflow(
        [node('gate', 'conditions', FALSE_CONDITIONS), node('body', 'mark')],
        [edge('gate', 'body', 'gate-output-1')],
      ),
      { executors: withBody(order), variables: { score: '10' } },
    )

    expect(order).toEqual(['body'])
    expect(result.completedNodeIds).toEqual(['gate', 'body'])
  })

  it('routes an unwired false verdict away from the true branch', async () => {
    const order: string[] = []
    await runWorkflow(
      makeWorkflow(
        [node('gate', 'conditions', FALSE_CONDITIONS), node('body', 'mark')],
        [edge('gate', 'body', 'gate-output-2')],
      ),
      { executors: withBody(order), variables: { score: '10' } },
    )

    expect(order).toEqual([])
  })
})
