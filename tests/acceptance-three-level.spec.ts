import { describe, expect, it } from 'vitest'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
import type { Workflow } from '../src/lib/workflow/types'
const passingProbe: ConditionPageProbe = {
  exists: async () => true, visible: async () => true, enabled: async () => true,
  text: async () => 'ok', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test',
}
function makeWorkflow(opts: {
  runOk: boolean; criteriaHeld?: boolean; goalHeld?: boolean; includeGoal?: boolean
}): { workflow: Workflow; run: never } {
  // Node contract is verified against the produced variable so L2 is
  // independent of the page probe; this isolates L3 goal failures.
  const nodeData = withNodeGoalContract({ blockId: 'event-click' }, {
    version: 1, goal: 'click submit',
    successCriteria: [
      opts.criteriaHeld === false
        ? ({ kind: 'variableExists', name: 'missing' } as never)
        : ({ kind: 'variableExists', name: 'clicked' } as never)
    ],
  })
  const settings: Record<string, unknown> = {
    saveLog:false, debugMode:false, notification:false, reuseLastState:false, provenance:'chat-generate',
  }
  if (opts.includeGoal !== false) {
    settings['goalSpec'] = {
      summary: 'The business result is visible.',
      successConditions: [
        opts.goalHeld === false
          ? ({ kind: 'elementExists', target: { testId: 'business-result-absent' } } as never)
          : ({ kind: 'elementExists', target: { testId: 'business-result' } } as never)
      ],
    }
  }
  const workflow = {
    id: 'w', name: 'w', description: '', createdAt: 0, updatedAt: 0,
    trigger: { type: 'manual', enabled: true }, settings,
    drawflow: { nodes: [{ id: 'n', label: 'event-click', position:{x:0,y:0}, data: nodeData }], edges: [] },
  } as unknown as Workflow
  return { workflow, run: { runId: 'r', outcome: opts.runOk ? 'ok' : 'failed', variables: { clicked: true } } as never }
}
const failingProbe: ConditionPageProbe = {
  ...passingProbe, exists: async () => false,
}
describe('V49 L1 execution verification', () => {
  it('marks every node executed only on a successful run', async () => {
    const ok = makeWorkflow({ runOk: true })
    const report = await verifyWorkflowGoal(ok.workflow, ok.run, passingProbe)
    expect(report.l1.every((e) => e.satisfied)).toBe(true)
    const bad = makeWorkflow({ runOk: false })
    const failed = await verifyWorkflowGoal(bad.workflow, bad.run, passingProbe)
    expect(failed.l1.every((e) => e.satisfied)).toBe(false)
    expect(failed.certified).toBe(false)
  })
})
describe('V50 L2 node contract verification', () => {
  it('fails the node when the block ran but the contract does not hold', async () => {
    const input = makeWorkflow({ runOk: true, criteriaHeld: false })
    const report = await verifyWorkflowGoal(input.workflow, input.run, failingProbe)
    expect(report.l2.allHeld).toBe(false)
    expect(report.level).toBe('L2')
    expect(report.certified).toBe(false)
  })
})
describe('V51 L3 workflow goal verification', () => {
  it('certifies only when the final goal conditions hold', async () => {
    const input = makeWorkflow({ runOk: true, criteriaHeld: true, goalHeld: true })
    const report = await verifyWorkflowGoal(input.workflow, input.run, passingProbe)
    expect(report.l3.allHeld).toBe(true)
    expect(report.level).toBe('L3')
    expect(report.certified).toBe(true)
  })
})
describe('V52 last node succeeds but workflow goal fails', () => {
  it('judges the workflow a failure (no fake success)', async () => {
    const input = makeWorkflow({ runOk: true, criteriaHeld: true, goalHeld: false })
    const report = await verifyWorkflowGoal(input.workflow, input.run, failingProbe)
    expect(report.passed).toBe(false)
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('L3')
  })
})