import { describe, expect, it } from 'vitest'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
import type { ExecuteWorkflowResult } from '../src/background/workflow-engine/run-workflow'
import type { Workflow } from '../src/lib/workflow/types'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
const probe: ConditionPageProbe = {
  exists: async () => true, visible: async () => true, enabled: async () => true,
  text: async () => 'Done', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test/done',
}
function workflow(): Workflow {
  const data = withNodeGoalContract({ blockId: 'forms' }, {
    version: 1, goal: 'fill result', successCriteria: [{ kind: 'variableExists', name: 'result' }],
  })
  return {
    id: 'w', name: 'w', description: '', createdAt: 0, updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog:false, debugMode:false, notification:false, reuseLastState:false, provenance:'chat-generate', goalSpec: { summary: 'goal', successConditions: [{ kind: 'variableExists', name: 'result' }] } },
    drawflow: { nodes: [{ id: 'n', label: 'forms', position:{x:0,y:0}, data }], edges: [] },
  } as unknown as Workflow
}
const run: ExecuteWorkflowResult = { runId: 'r', outcome: 'ok', variables: { result: 'x' } }
describe('V53 workflow goal success evidence', () => {
  it('records a description and detail per condition for the user', async () => {
    const report = await verifyWorkflowGoal(workflow(), run, probe)
    for (const evidence of report.l3.conditions) {
      expect(evidence.description.length).toBeGreaterThan(0)
      expect(typeof evidence.satisfied).toBe('boolean')
    }
    // L2 node evidence carries the same proof, node by node.
    for (const node of report.l2.nodes) for (const evidence of node.criteria) expect(evidence.description).toBeTruthy()
  })
})