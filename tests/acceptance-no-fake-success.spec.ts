import { describe, expect, it } from 'vitest'
import { compileIR, type WorkflowIR } from '../src/lib/workflow/ir'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
const okProbe: ConditionPageProbe = { exists: async () => true, visible: async () => true, enabled: async () => true, text: async () => 'ok', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test' }
const failProbe: ConditionPageProbe = { ...okProbe, exists: async () => false }
function ir(goalTarget = 'g', nodeTarget = 'n'): WorkflowIR {
  return { version:1, goal:{summary:'G',successConditions:[{kind:'elementExists',target:{testId:goalTarget}}] as never[]},inputs:[],steps:[{id:'s',intent:'click',action:{kind:'click'},target:{kind:'element',semantic:{testId:nodeTarget}} as never,preconditions:[],postconditions:[{kind:'elementExists',target:{testId:nodeTarget}}] as never[]} as never],edges:[],metadata:{} }
}
describe('V99 failures cannot be disguised as success', () => {
  it('node executed but goal failed → workflow FAIL', async () => {
    // Node contract holds (node target resolves) but goal target does not.
    const probe: ConditionPageProbe = { ...failProbe,
      exists: async (locator) => (locator as { testId?: string }).testId === 'n' }
    const report = await verifyWorkflowGoal(compileIR(ir()), { runId:'r', outcome:'ok', variables:{} } as never, probe)
    expect(report.passed).toBe(false)
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
  })
  it('node contract failure → not certified', async () => {
    const report = await verifyWorkflowGoal(compileIR(ir()), { runId:'r', outcome:'ok', variables:{} } as never, failProbe)
    expect(report.l2.allHeld).toBe(false)
    expect(report.certified).toBe(false)
  })
  it('L1 failure → not certified regardless of goal evidence', async () => {
    const report = await verifyWorkflowGoal(compileIR(ir()), { runId:'r', outcome:'failed', variables:{} } as never, okProbe)
    expect(report.certified).toBe(false)
  })
})