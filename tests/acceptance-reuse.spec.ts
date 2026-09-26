import { describe, expect, it } from 'vitest'
import { compileIR, type WorkflowIR } from '../src/lib/workflow/ir'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
const probe: ConditionPageProbe = { exists: async () => true, visible: async () => true, enabled: async () => true, text: async () => 'ok', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test' }
function ir(): WorkflowIR {
  return { version: 1, goal: { summary: 'Replay goal', successConditions: [{ kind:'variableExists', name:'out' }] as never[] }, inputs: [], steps: [{ id: 's', intent: 'produce output', action:{kind:'click'}, target:{kind:'element',semantic:{testId:'x'}} as never, preconditions:[], postconditions:[{kind:'variableExists',name:'out'}] as never[] } as never], edges:[], metadata:{} }
}
describe('V98 generated result is reusable across runs', () => {
  it('replays the same saved workflow twice and the goal holds both times', async () => {
    const workflow = compileIR(ir()) // saved once
    // First run
    const run1 = await verifyWorkflowGoal(workflow, { runId:'r1', outcome:'ok', variables:{out:'a'} } as never, probe)
    expect(run1.certified).toBe(true)
    // Second independent replay — fresh run context, no conversation state.
    const run2 = await verifyWorkflowGoal(workflow, { runId:'r2', outcome:'ok', variables:{out:'b'} } as never, probe)
    expect(run2.certified).toBe(true)
    expect(run1.reason).toBe(run2.reason)
  })
})