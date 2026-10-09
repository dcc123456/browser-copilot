/**
 * The run gate stops at the step that cannot work — it does not refuse the run.
 *
 * `workflows.run` used to `throw` when `validateWorkflowForRun` reported an
 * error: twenty connected nodes, none of them executed, and the reason lived
 * only in a toast that named a node the canvas could not scroll to. The gate's
 * findings now ride on the run as `preflightBlockers`, so everything before the
 * first unfilled step still happens, the log names the step, and the page is
 * never touched by a node that has nothing to act on (the empty locator would
 * otherwise poll readiness until `READINESS_TIMEOUT` and blame the page).
 *
 * See specs/2026-10-06-run-preflight-log-design.md.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

/** `read → click`, the shape a generated graph has when a locator went missing. */
function graph(): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: [
        node('a', 'get-text', { selector: '', variableName: 'draftTitles' }),
        node('b', 'event-click', { selector: '#publish' }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

function executors(ran: string[]) {
  return {
    'get-text': async () => {
      ran.push('read')
      return null
    },
    'event-click': async () => {
      ran.push('click')
      return null
    },
  }
}

const BLOCKER = '缺少必填参数 selector：缺少元素定位。'

describe('the preflight stop', () => {
  it('runs the nodes before the blocker and stops in front of it', async () => {
    const ran: string[] = []
    const result = await runWorkflow(
      {
        ...graph(),
        drawflow: {
          nodes: [
            node('z', 'event-click', { selector: '#open' }),
            node('a', 'get-text', { selector: '' }),
            node('b', 'event-click', { selector: '#publish' }),
          ],
          edges: [
            { id: 'z->a', source: 'z', target: 'a' },
            { id: 'a->b', source: 'a', target: 'b' },
          ],
        },
      },
      {
        executors: executors(ran),
        preflightBlockers: { a: BLOCKER },
      },
    )
    expect(ran).toEqual(['click'])
    expect(result.outcome).toBe('failed')
    expect(result.error).toBe(BLOCKER)
    expect(result.completedNodeIds).toEqual(['z'])
  })

  it('logs the stop under the blocked node, so the row names the step', async () => {
    const result = await runWorkflow(graph(), {
      executors: executors([]),
      preflightBlockers: { a: BLOCKER },
    })
    const steps = result.steps ?? []
    const errorStep = steps.find((s) => s.kind === 'error')
    expect(errorStep?.nodeId).toBe('a')
    expect(errorStep?.text).toContain('缺少必填参数 selector')
    // Nothing after the stop executed.
    expect(steps.some((s) => s.nodeId === 'b')).toBe(false)
  })

  it('leaves a workflow without blockers exactly as it was', async () => {
    const ran: string[] = []
    const result = await runWorkflow(graph(), { executors: executors(ran) })
    expect(ran).toEqual(['read', 'click'])
    expect(result.outcome).toBe('ok')
  })

  it('skips a blocked node the user disabled instead of stopping', async () => {
    // The engine drops a `disableBlock` node before it consults the gate, so a
    // step that is not going to run cannot end the run.
    const ran: string[] = []
    const result = await runWorkflow(
      {
        ...graph(),
        drawflow: {
          nodes: [
            node('a', 'get-text', { selector: '', disableBlock: true }),
            node('b', 'event-click', { selector: '#publish' }),
          ],
          edges: [{ id: 'a->b', source: 'a', target: 'b' }],
        },
      },
      { executors: executors(ran), preflightBlockers: { a: BLOCKER } },
    )
    expect(result.outcome).toBe('ok')
    expect(ran).toEqual(['click'])
  })
})
