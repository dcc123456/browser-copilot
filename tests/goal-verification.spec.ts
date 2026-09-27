import { describe, expect, it } from 'vitest'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
import type { ExecuteWorkflowResult } from '../src/background/workflow-engine/run-workflow'
import type { Workflow } from '../src/lib/workflow/types'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
const probe: ConditionPageProbe = {
  exists: async () => true, visible: async () => true, enabled: async () => true,
  text: async () => 'Done', attribute: async () => 'value', count: async () => 1, url: async () => 'https://example.com/done',
}
function workflowWith(nodeData: Record<string, unknown>): Workflow {
  return {
    id: 'w1', name: 'Task', description: '', createdAt: 0, updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: false, debugMode: false, notification: false, reuseLastState: false, provenance: 'chat-generate',
      goalSpec: { summary: 'The done banner exists.', successConditions: [{ kind: 'variableExists', name: 'result' }] },
    },
    drawflow: { nodes: [{ id: 'n1', label: 'forms', position: { x: 0, y: 0 }, data: { blockId: 'forms', ...nodeData } }], edges: [] },
  } as unknown as Workflow
}
const okRun: ExecuteWorkflowResult = { runId: 'r1', outcome: 'ok', variables: { result: 'done' } }
describe('goal verification engine', () => {
  it('certifies when L1/L2/L3 all pass', async () => {
    const data = withNodeGoalContract({ blockId: 'forms' }, {
      version: 1, goal: 'fill the result', successCriteria: [{ kind: 'variableExists', name: 'result' }],
    })
    const report = await verifyWorkflowGoal(workflowWith(data), okRun, probe)
    expect(report.l1.every((c) => c.satisfied)).toBe(true)
    expect(report.l2.allHeld).toBe(true)
    expect(report.l3.allHeld).toBe(true)
    expect(report.certified).toBe(true)
  })
  it('fails L1 when execution failed', async () => {
    const failedRun: ExecuteWorkflowResult = { runId: 'r2', outcome: 'failed', error: 'boom', variables: {} }
    const report = await verifyWorkflowGoal(workflowWith({}), failedRun, probe)
    expect(report.level).toBe('L1')
    expect(report.certified).toBe(false)
  })
  it('fails L2 when a node contract does not hold', async () => {
    const data = withNodeGoalContract({ blockId: 'forms' }, {
      version: 1, goal: 'need missing var', successCriteria: [{ kind: 'variableExists', name: 'missing' }],
    })
    const report = await verifyWorkflowGoal(workflowWith(data), okRun, probe)
    expect(report.level).toBe('L2')
    expect(report.certified).toBe(false)
  })
  it('last node succeeds but goal fails: L3 fail, not certified', async () => {
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = { summary: 'need goalVar', successConditions: [{ kind: 'variableExists', name: 'goalVar' }] }
    const report = await verifyWorkflowGoal(workflow, okRun, probe)
    expect(report.l3.allHeld).toBe(false)
    expect(report.level).toBe('L3')
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('L3')
  })
  it('a step that never ran fails L1 even when the run as a whole finished OK', async () => {
    // `onError: continue` and untaken branches produce exactly this run: outcome
    // 'ok' with a node left behind. Certifying it would call a partial run a
    // verified one.
    const partialRun: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: [],
    }
    const report = await verifyWorkflowGoal(workflowWith({}), partialRun, probe)
    expect(report.l1[0]?.satisfied).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('L1')
  })
  it('an unconfirmed declared outcome withholds the badge without failing the run', async () => {
    const data = withNodeGoalContract({ blockId: 'forms' }, {
      version: 1, goal: 'fill the result', successCriteria: [{ kind: 'variableExists', name: 'result' }],
    })
    const softRun: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: ['n1'],
      conditionWarnings: ['n2: 元素新出现 [role=dialog]'],
    }
    const report = await verifyWorkflowGoal(workflowWith(data), softRun, probe)
    expect(report.l3.allHeld).toBe(true)
    expect(report.softUnconfirmed).toEqual(['n2: 元素新出现 [role=dialog]'])
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('not confirmed')
  })
  it('reports L2 as unevaluated when no node declared a contract', async () => {
    const report = await verifyWorkflowGoal(
      workflowWith({}),
      { ...okRun, completedNodeIds: ['n1'] },
      probe,
    )
    expect(report.l2.allHeld).toBe(true)
    expect(report.l2.evaluated).toBe(false)
    // Nothing at the node layer was checked, so a pass here comes from L3 alone.
    expect(report.l2.nodes[0]?.criteria).toHaveLength(0)
  })
})