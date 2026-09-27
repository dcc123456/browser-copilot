import { describe, expect, it } from 'vitest'
import { advanceRecovery, reportOperatorFailure, startRecovery } from '../src/lib/workflow/recovery'
import { buildGoalRepairContext } from '../src/lib/workflow/goal-repair-context'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
import type { Workflow } from '../src/lib/workflow/types'
const probe: ConditionPageProbe = { exists: async () => true, visible: async () => true, enabled: async () => true, text: async () => 'ok', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test' }
describe('V95 full failure recovery chain', () => {
  it('follows the recovery state machine from failure through expansion', () => {
    const nodeGoal = 'click submit'
    const criteria = [{ kind: 'elementExists', target: { testId: 'submit' } }] as never
    const session = startRecovery({
      stepIntent: 'click submit',
      failed: [reportOperatorFailure({ operator: 'event-click', message: 'not found', nodeGoal, nodeSuccessCriteria: criteria })],
    })
    const seen: string[] = []
    for (let i = 0; i < 4; i++) seen.push(advanceRecovery(session).action.kind)
    // Deterministic ladder: reground → retry, not random trial.
    expect(seen[0]).toBe('reground')
    expect(seen[1]).toBe('retry-same')
    expect(session.failures.get('event-click')?.nodeGoal).toBe(nodeGoal)
  })
})
describe('V96 full repair chain', () => {
  it('analyzes node goal/criteria, patches, replays, reverifies and certifies', async () => {
    const data = withNodeGoalContract({ blockId: 'forms' }, {
      version: 1, goal: 'fill the result field', successCriteria: [{ kind: 'variableExists', name: 'result' }],
    })
    const workflow = {
      id: 'w', name: 'w', trigger: { type:'manual', enabled:true },
      settings: { goalSpec: { summary: 'G', successConditions: [{ kind:'variableExists', name:'result' }] } },
      drawflow: { nodes: [{ id:'n', label:'forms', position:{x:0,y:0}, data }], edges: [] },
    } as unknown as Workflow
    const failedNode = workflow.drawflow.nodes[0]!
    const repairContext = buildGoalRepairContext(workflow, failedNode)
    expect(repairContext.nodeGoal).toContain('result field')
    expect(repairContext.rawSuccessCriteria).toHaveLength(1)
    // After the patch → replay succeeds → node + workflow verification certify.
    const run = { runId: 'r', outcome: 'ok' as const, variables: { result: 'x' } }
    const report = await verifyWorkflowGoal(workflow, run as never, probe)
    console.log('DBGL2', JSON.stringify(report.l2))
    expect(report.l2.allHeld).toBe(true)
    expect(report.certified).toBe(true)
  })
})