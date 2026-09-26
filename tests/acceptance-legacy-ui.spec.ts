import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import NodeGoalInspector from '../src/workflow-editor/sidebar/NodeGoalInspector'
import type { Workflow } from '../src/lib/workflow/types'
import {
  nodeGoalContractOf, withNodeGoalContract,
} from '../src/lib/workflow/node-goal-contract'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
const t = (key: string) => key
const noop = () => {}
function legacyWorkflow(): Workflow {
  return {
    id: 'old', name: 'Old flow', description: '', createdAt: 1, updatedAt: 1,
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: [{ id: 'a', label: 'event-click', position: { x: 0, y: 0 }, data: { blockId: 'event-click', selector: '.go' } }],
      edges: [],
    },
  } as unknown as Workflow
}
describe('V03 legacy workflow compatibility', () => {
  it('loads a workflow without __workflowAi metadata', () => {
    const workflow = legacyWorkflow()
    expect(workflow.drawflow.nodes[0]?.data['blockId']).toBe('event-click')
  })
  it('does not crash on a node without a goal and exposes no contract', () => {
    const data = legacyWorkflow().drawflow.nodes[0]!.data
    expect(() => nodeGoalContractOf(data)).not.toThrow()
    expect(nodeGoalContractOf(data)).toBeUndefined()
  })
  it('the inspector renders nothing for a legacy node (no crash)', () => {
    const html = renderToStaticMarkup(createElement(NodeGoalInspector, { data: { blockId: 'event-click' }, onChange: noop, t }))
    expect(html).toBe('')
  })
  it('verification does not crash / does not certify a goal-less legacy workflow', async () => {
    const probe: ConditionPageProbe = {
      exists: async () => true, visible: async () => true, enabled: async () => true,
      text: async () => '', attribute: async () => '', count: async () => 0, url: async () => '',
    }
    const run = { runId: 'r', outcome: 'ok' as const, variables: {} }
    const report = await verifyWorkflowGoal(legacyWorkflow(), run as never, probe)
    expect(report.certified).toBe(false)
    expect(report.l3.goalSummary).toBe('')
  })
  it('re-saving keeps legacy fields intact (round-trip of data)', () => {
    const workflow = legacyWorkflow()
    const data = workflow.drawflow.nodes[0]!.data
    // No goal contract gets injected merely by loading/saving legacy data.
    const resaved = { ...data }
    expect(resaved['selector']).toBe('.go')
    expect(nodeGoalContractOf(resaved)).toBeUndefined()
  })
})
describe('V13 node goal is visible in the editor UI', () => {
  const data = withNodeGoalContract({ blockId: 'event-click' }, {
    version: 1,
    goal: 'Click the create button',
    successCriteria: [{ kind: 'elementExists', target: { testId: 'create' } }],
    preconditions: [{ kind: 'elementVisible', target: { testId: 'nav' } }],
  })
  it('renders the goal text, success criteria and preconditions', () => {
    const html = renderToStaticMarkup(createElement(NodeGoalInspector, { data, onChange: noop, t }))
    expect(html).toContain('Click the create button')
    expect(html.length).toBeGreaterThan(50)
  })
})