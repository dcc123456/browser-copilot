/**
 * Repair verification must not grade an empty ballot as a pass.
 *
 * The L1/L2/L3 layers answer different questions, and a candidate that had
 * NOTHING to check at a layer did not earn that layer. Before this, the
 * terminal-state (S0) strategy could declare a repair `AUTO_REPAIRED` having
 * evaluated zero conditions, and the noop readiness candidate reported "all
 * verification layers passed" for a workflow with no goal contract at all.
 *
 * These tests pin the distinction between "nothing contradicted us" (`satisfied`)
 * and "we actually looked" (`evaluated`) — the repair loop still accepts the
 * first, but the record now says which one happened.
 */
import { describe, expect, it } from 'vitest'
import {
  checkGoalAlreadySatisfied,
  verifyRepair,
  verifyRepairCandidate,
  type VerificationDeps,
} from '../src/lib/workflow/repair-verification'
import type { RepairCandidate } from '../src/lib/workflow/repair-candidate'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import type { Workflow } from '../src/lib/workflow/types'

function workflowWithGoal(
  successConditions: WorkflowCondition[],
  terminalStateConditions?: WorkflowCondition[],
): Workflow {
  return {
    id: 'w1',
    name: 'Task',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [], edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      goalSpec: {
        summary: 'order submitted',
        successConditions,
        ...(terminalStateConditions ? { terminalStateConditions } : {}),
      },
    },
  } as unknown as Workflow
}

const goalless = {
  id: 'w0',
  name: 'Read',
  createdAt: 0,
  updatedAt: 0,
  drawflow: { nodes: [], edges: [] },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

const noop: RepairCandidate = {
  strategy: 'readiness-recovery',
  reason: 'no graph change',
  nodePatches: [],
  edgePatches: [],
  expectedPostconditions: [],
}

function candidateWith(postconditions: WorkflowCondition[]): RepairCandidate {
  return { ...noop, expectedPostconditions: postconditions }
}

/** A verifier that answers every condition the same way. */
function answering(satisfied: boolean): VerificationDeps & { asked: WorkflowCondition[][] } {
  const asked: WorkflowCondition[][] = []
  return {
    asked,
    evaluateConditions: async (conditions) => {
      asked.push(conditions)
      return conditions.map((condition) => ({ condition, satisfied }))
    },
  }
}

const urlHolds: WorkflowCondition[] = [{ kind: 'urlContains', value: '/orders/1' }]

describe('repair verification layers', () => {
  it('accepts a goal-less candidate on the node result, and says so', async () => {
    const result = await verifyRepairCandidate({
      workflow: goalless,
      candidate: noop,
      nodeSucceeded: true,
      deps: answering(true),
    })
    expect(result.passed).toBe(true)
    expect(result.layers).toEqual({ node: true, postconditions: true, goal: true })
    // The honest half: none of those layers had anything to check.
    expect(result.evaluated).toEqual({ postconditions: false, goal: false })
    expect(result.evaluatedConditions).toHaveLength(0)
    expect(result.note).toContain('no goal contract')
  })

  it('does not let a node failure be talked around by a holding goal', async () => {
    const result = await verifyRepairCandidate({
      workflow: workflowWithGoal(urlHolds),
      candidate: noop,
      nodeSucceeded: false,
      deps: answering(true),
    })
    expect(result.passed).toBe(false)
    expect(result.layers.goal).toBe(true)
    expect(result.evaluated.goal).toBe(true)
  })

  it('reports the unmet condition when the goal did not happen', async () => {
    const deps = answering(false)
    const result = await verifyRepairCandidate({
      workflow: workflowWithGoal(urlHolds),
      candidate: candidateWith(urlHolds),
      nodeSucceeded: true,
      deps,
    })
    expect(result.passed).toBe(false)
    expect(result.layers).toEqual({ node: true, postconditions: false, goal: false })
    expect(result.unmet.length).toBeGreaterThan(0)
    expect(result.note).toBe(result.unmet[0])
    expect(deps.asked).toHaveLength(2)
  })

  it('credits the terminal state when the success condition came too late', async () => {
    const result = await verifyRepairCandidate({
      workflow: workflowWithGoal(urlHolds, [{ kind: 'variableExists', name: 'orderId' }]),
      candidate: noop,
      nodeSucceeded: true,
      deps: {
        evaluateConditions: async (conditions) =>
          conditions.map((condition) => ({
            condition,
            satisfied: condition.kind === 'variableExists',
          })),
      },
    })
    expect(result.passed).toBe(true)
    expect(result.evaluated.goal).toBe(true)
  })
})

describe('S0 terminal-state short-circuit', () => {
  it('only short-circuits on conditions it actually evaluated', async () => {
    const deps = answering(true)
    const already = await checkGoalAlreadySatisfied(workflowWithGoal(urlHolds), deps)
    expect(already.satisfied).toBe(true)
    expect(already.evaluated).toEqual(urlHolds)
    expect(already.note).toContain('already hold')
  })

  it('claims nothing for a goal whose conditions all failed', async () => {
    const already = await checkGoalAlreadySatisfied(
      workflowWithGoal(urlHolds),
      answering(false),
    )
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual(urlHolds)
  })

  it('has no goal to confirm on a goal-less workflow', async () => {
    const already = await checkGoalAlreadySatisfied(goalless, answering(true))
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual([])
  })

  it('reports the goal observation as the evidence, not the layers it never ran', async () => {
    const result = await verifyRepair(workflowWithGoal(urlHolds), noop, false, answering(true))
    expect(result.passed).toBe(true)
    expect(result.alreadySatisfied).toBe(true)
    expect(result.evaluated).toEqual({ postconditions: false, goal: true })
    expect(result.evaluatedConditions).toEqual(urlHolds)
  })
})
