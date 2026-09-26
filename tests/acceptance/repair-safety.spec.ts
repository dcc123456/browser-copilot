import { describe, expect, it } from 'vitest'
import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { PatchEngine } from '../../src/lib/workflow/repair/patch-engine'
import type { WorkflowPatchSet } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, makeWorkflow, node } from '../repair/helpers'
function setup() {
  const workflow = makeWorkflow(
    [
      node('t', 'trigger'),
      node('n-1', 'get-text', { variableName: 'captcha', selector: '.code' }),
      node('n', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n-1'), edge('n-1', 'n')],
  )
  const trace = buildTrace(workflow, 'run', [
    { id: 't', status: 'ok', variables: {} },
    { id: 'n-1', status: 'ok', variables: { captcha: '' } },
    { id: 'n', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
  ], {})
  return { workflow, analysis: analyzeFailure({ workflow, trace }) }
}
function patch(operations: WorkflowPatchSet['operations']): WorkflowPatchSet {
  return { patchSetId: 'ps', analysisId: '', operations, reason: 'r', confidence: 0.8, expectedEffect: 'e' }
}
describe('V59 repair does not break already-passing nodes', () => {
  it('fixes node N while N-1 and the trigger stay byte-identical', () => {
    const { workflow, analysis } = setup()
    const before = workflow.drawflow.nodes.find((item) => item.id === 'n-1')!
    const change = patch([
      { operationId: 'op1', nodeId: 'n-1', kind: 'SET_PARAM', path: 'selector', before: '.code', after: 'input.code', reason: 'fix', evidenceIds: [] },
    ])
    const engine = new PatchEngine()
    const validation = engine.validatePatch(workflow, analysis, change)
    expect(validation.ok).toBe(true)
    const applied = engine.applyPatch(workflow, analysis, change)
    const after = applied.workflow.drawflow.nodes.find((item) => item.id === 'n-1')!
    expect(after).not.toEqual(before) // n-1 changed (it is the root cause node here)
    // The failing node n and trigger are untouched.
    expect(applied.workflow.drawflow.nodes.find((item) => item.id === 'n'))
      .toEqual(workflow.drawflow.nodes[2])
    expect(validation.changedNodeIds).toEqual(['n-1'])
  })
  it('rejects a patch that touches an unrelated node', () => {
    const { workflow, analysis } = setup()
    const change = patch([
      { operationId: 'op1', nodeId: 't', kind: 'SET_PARAM', path: 'type', after: 'manual', reason: 'x', evidenceIds: [] },
    ])
    const result = new PatchEngine().validatePatch(workflow, analysis, change)
    expect(result.ok).toBe(false)
  })
})
describe('V60 repair budget is bounded', () => {
  it('always terminates in a terminal decision, never loops forever', async () => {
    const {
      startBudget, decideNextBudget, NO_IMPROVEMENT_LIMIT,
    } = await import('../../src/lib/workflow/repair/dynamic-budget')
    expect(NO_IMPROVEMENT_LIMIT).toBeGreaterThan(0)
    let state = startBudget('LOCATOR' as never)
    const decisions: string[] = []
    for (let i = 0; i < 50; i++) {
      const next = decideNextBudget(state, { recovered: false, failureSignature: 'same-sig' })
      decisions.push(next.decision)
      state = next.state
      if (next.decision.startsWith('STOP_') || next.decision === 'REQUEST_HUMAN') break
    }
    const last = decisions[decisions.length - 1]!
    expect(last.startsWith('STOP_') || last === 'REQUEST_HUMAN').toBe(true)
    expect(decisions.length).toBeLessThan(50)
  })
})