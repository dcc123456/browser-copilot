import { describe, expect, it } from 'vitest'
import { compileIR, type WorkflowIR } from '../src/lib/workflow/ir'
import { validateGeneratedWorkflow } from '../src/lib/workflow/generated-validation'
import { validateWorkflowForRun } from '../src/lib/workflow/validation'
function validIR(): WorkflowIR {
  return {
    version: 1,
    goal: { summary: 'G', successConditions: [{ kind: 'elementExists', target: { testId: 'x' } }] as never[] },
    inputs: [],
    steps: [{
      id: 's1', intent: 'Click', action: { kind: 'click' },
      target: { kind: 'element', semantic: { testId: 'x' } } as never,
      preconditions: [],
      postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }] as never[],
      idempotency: 'conditional', sourceTraceIds: [],
    } as never],
    edges: [], metadata: {},
  }
}
describe('V64 static validation after compile', () => {
  it('accepts a well-formed compiled workflow', () => {
    const workflow = compileIR(validIR())
    expect(validateWorkflowForRun(workflow).errors).toEqual([])
    expect(validateGeneratedWorkflow(workflow).ok).toBe(true)
  })
  it('reports an unreachable node when an edge is broken', () => {
    const workflow = compileIR(validIR())
    workflow.drawflow.edges[0]!.source = 'ghost'
    const generated = validateGeneratedWorkflow(workflow)
    expect(generated.ok).toBe(false)
    expect(generated.errors.some((e) => /不可达|断链/.test(e.message))).toBe(true)
  })
  it('reports an action node missing its goal contract', () => {
    const workflow = compileIR(validIR())
    // Make the node unsafe (submit intent) so the contract is mandatory.
    workflow.drawflow.nodes[1]!.data['description'] = '提交订单'
    delete workflow.drawflow.nodes[1]!.data['__workflowAi']
    const generated = validateGeneratedWorkflow(workflow)
    expect(generated.errors.some((e) => e.code === 'NODE_GOAL_MISSING')).toBe(true)
  })
  it('reports a missing workflow goal for an unsafe graph', () => {
    const workflow = compileIR(validIR())
    workflow.drawflow.nodes[1]!.data['description'] = '提交订单'
    ;(workflow.drawflow.nodes[1]!.data['__workflowAi'] as { goal: string }).goal = '提交订单'
    delete workflow.settings.goalSpec
    const generated = validateGeneratedWorkflow(workflow)
    expect(generated.errors.some((e) => e.code === 'GOAL_MISSING')).toBe(true)
  })
})