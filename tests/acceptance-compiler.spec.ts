import { describe, expect, it } from 'vitest'
import { compileIR, type WorkflowIR } from '../src/lib/workflow/ir'
import { goalSpecOf } from '../src/lib/workflow/reliability'
import { nodeGoalContractOf } from '../src/lib/workflow/node-goal-contract'
function ir(): WorkflowIR {
  return {
    version: 1,
    goal: {
      summary: 'Submit the form and show the success banner',
      successConditions: [{ kind: 'elementExists', target: { testId: 'banner' } }] as never[],
    },
    inputs: [],
    steps: [
      {
        id: 's1',
        intent: 'Click the submit button',
        action: { kind: 'click' },
        target: { kind: 'element', semantic: { testId: 'submit' } } as never,
        preconditions: [{ kind: 'elementVisible', target: { testId: 'submit' } }] as never[],
        postconditions: [{ kind: 'elementExists', target: { testId: 'submit' } }] as never[],
      } as never,
    ],
    edges: [],
    metadata: {},
  }
}
describe('V61 workflow goal survives compilation', () => {
  it('the compiled workflow keeps the goal spec with summary and conditions', () => {
    const workflow = compileIR(ir())
    const goal = goalSpecOf(workflow)!
    expect(goal.summary).toBe('Submit the form and show the success banner')
    expect(goal.successConditions).toHaveLength(1)
  })
})
describe('V62 node goal contract survives compilation', () => {
  it('the node keeps its intent as goal and its criteria/preconditions', () => {
    const workflow = compileIR(ir())
    const node = workflow.drawflow.nodes.find((item) => item.id === 's1')!
    const contract = nodeGoalContractOf(node.data)!
    expect(contract.goal).toBe('Click the submit button')
    expect(contract.successCriteria).toHaveLength(1)
    expect(contract.preconditions).toHaveLength(1)
  })
})
describe('V63 compiler produces a wired workflow graph', () => {
  it('emits node ids, handles and edges without manual wiring', () => {
    const workflow = compileIR(ir())
    expect(workflow.drawflow.nodes.map((n) => n.id)).toContain('s1')
    const edge = workflow.drawflow.edges[0]!
    expect(edge.sourceHandle).toContain('output')
    expect(edge.targetHandle).toContain('input')
    expect(edge.source).toBe('trigger')
    expect(edge.target).toBe('s1')
  })
})