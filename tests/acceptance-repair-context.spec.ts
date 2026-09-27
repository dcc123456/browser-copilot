import { describe, expect, it } from 'vitest'
import {
  buildGoalRepairContext, renderGoalRepairContext,
} from '../src/lib/workflow/goal-repair-context'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
function setup(): { workflow: Workflow; failed: WorkflowNode } {
  const failedData = withNodeGoalContract({ blockId: 'event-click' }, {
    version: 1,
    goal: 'Open the create-customer form',
    successCriteria: [{ kind: 'elementExists', target: { testId: 'create-form' } }],
    preconditions: [{ kind: 'elementVisible', target: { testId: 'nav' } }],
    failureMeaning: ['The form did not open.'],
    repairHints: [{ target: 'locator', action: 'Re-ground on the nav button.' }],
  })
  const failed: WorkflowNode = { id: 'n2', label: 'event-click', position:{x:0,y:0}, data: failedData }
  const trigger: WorkflowNode = { id: 'trigger', label: 'trigger', position:{x:0,y:0}, data: { blockId: 'trigger' } }
  const workflow = {
    id: 'w', name: 'w', description: '', createdAt: 0, updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog:false, debugMode:false, notification:false, reuseLastState:false, provenance:'chat-generate', goalSpec: { summary: 'A customer is created.', successConditions: [{ kind: 'elementExists', target: { testId: 'customer-created' } }] } },
    drawflow: { nodes: [trigger, failed], edges: [] },
  } as unknown as Workflow
  return { workflow, failed }
}
describe('V54 repair context includes the node goal', () => {
  it('contains goal, success criteria, preconditions and failure evidence', () => {
    const { workflow, failed } = setup()
    const context = buildGoalRepairContext(workflow, failed)
    expect(context.nodeGoal).toContain('create-customer form')
    expect(context.nodeSuccessCriteria.length).toBe(1)
    expect(context.preconditions).toHaveLength(1)
    expect(context.workflowGoal?.summary).toContain('customer is created')
    expect(context.rawSuccessCriteria).toHaveLength(1)
    const rendered = renderGoalRepairContext(context)
    expect(rendered).toContain('NODE GOAL')
  })
})
describe('V55 locator failure repair preserves the same node goal', () => {
  it('the context anchors the fix to the existing goal', () => {
    const { workflow, failed } = setup()
    const context = buildGoalRepairContext(workflow, failed)
    expect(context.nodeGoal).toBe('Open the create-customer form')
    expect(context.repairHints?.[0]?.target).toBe('locator')
  })
})
describe('V56 parameter repair aligns to success criteria', () => {
  it('exposes the criteria that must still hold after a parameter fix', () => {
    const { workflow, failed } = setup()
    const context = buildGoalRepairContext(workflow, failed)
    expect(context.nodeSuccessCriteria[0]).toContain('create-form')
  })
})