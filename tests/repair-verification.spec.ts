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
 *
 * The second rule pinned here is about WHAT counts as evidence at S0. A URL
 * records where the run IS, not what it DID: the publish page is still
 * `/publish/` when the title never committed, so a goal whose only success row
 * is `urlContains` holds before the failed step, while it and after it. Reading
 * that as "already satisfied" closes the whole ladder on attempt one and reports
 * a repair that changed nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  checkGoalAlreadySatisfied,
  provesLandedEffect,
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

/** A graph whose first node navigates to `url` — the anchor generation adds. */
function navigatingWorkflow(url: string): Workflow {
  const workflow = workflowWithGoal([])
  workflow.drawflow.nodes = [
    {
      id: 'n1',
      label: 'Open tab',
      data: { blockId: 'open-url', url },
    },
  ] as never
  return workflow
}

const goalless = {  id: 'w0',
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

/** A success row that could only be true AFTER the failed step did its work. */
const landedEffect: WorkflowCondition[] = [{ kind: 'variableExists', name: 'draftId' }]

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
  it('short-circuits only on a success row that can prove the effect landed', async () => {
    const deps = answering(true)
    const already = await checkGoalAlreadySatisfied(workflowWithGoal(landedEffect), deps)
    expect(already.satisfied).toBe(true)
    expect(already.evaluated).toEqual(landedEffect)
    expect(already.note).toContain('already hold')
  })

  it('will not read a URL as proof of a step that never happened', async () => {
    const deps = answering(true)
    const already = await checkGoalAlreadySatisfied(workflowWithGoal(urlHolds), deps)
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual([])
    // The URL was never even looked at: it cannot answer the S0 question.
    expect(deps.asked).toHaveLength(0)
  })

  it('still credits a terminal state the page reached after the action', async () => {
    const already = await checkGoalAlreadySatisfied(
      workflowWithGoal(urlHolds, [{ kind: 'urlContains', value: '/orders/123' }]),
      answering(true),
    )
    expect(already.satisfied).toBe(true)
    expect(already.note).toContain('terminal state')
  })

  it('refuses a terminal URL the workflow puts the browser on itself', async () => {
    // The round-17 draft graph, exactly: its only terminal row was
    // `urlContains creator.xiaohongshu.com` while its first node OPENS that
    // page. S0 read that as "terminal state already holds", the repair committed
    // nothing, and a step that ran out of its tool budget was reported repaired.
    const graph = navigatingWorkflow('https://creator.xiaohongshu.com/publish/publish')
    graph.settings!.goalSpec = {
      summary: 'draft saved',
      successConditions: urlHolds,
      terminalStateConditions: [{ kind: 'urlContains', value: 'creator.xiaohongshu.com' }],
    }
    const deps = answering(true)
    const already = await checkGoalAlreadySatisfied(graph, deps)
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual([])
    expect(deps.asked).toHaveLength(0)
  })

  it('draws the line at the address, not at the site', async () => {
    // Same host, different page: the draft list is only reachable once the draft
    // exists, so that row is real evidence and stays credited.
    const graph = navigatingWorkflow('https://creator.xiaohongshu.com/publish/publish')
    graph.settings!.goalSpec = {
      summary: 'draft saved',
      successConditions: urlHolds,
      terminalStateConditions: [{ kind: 'urlContains', value: '/creator/draft' }],
    }
    const already = await checkGoalAlreadySatisfied(graph, answering(true))
    expect(already.satisfied).toBe(true)
    expect(already.note).toContain('terminal state')
  })

  it('claims nothing for a goal whose evidence conditions all failed', async () => {
    const already = await checkGoalAlreadySatisfied(
      workflowWithGoal(landedEffect),
      answering(false),
    )
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual(landedEffect)
  })

  it('refuses a terminal row that only asserts the document exists', async () => {
    // Round 31, verbatim: the goal's terminal row was `elementExists` on `body` —
    // the locator a model writes when it has none. Making `{selector}` targets
    // observable made the row RESOLVE, and it resolves always, so S0 closed the
    // ladder in 14 ms with "terminal state already holds" over a step that had
    // just died on 小红书's hidden upload control, and the repair reported success
    // without a model call. An absence would prove something; this proves nothing.
    const vacuous: WorkflowCondition = { kind: 'elementExists', target: { selector: 'body' } }
    const deps = answering(true)
    const already = await checkGoalAlreadySatisfied(
      workflowWithGoal([vacuous], [vacuous]),
      deps,
    )
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual([])
    expect(deps.asked).toHaveLength(0)
  })

  it('still credits a terminal row that names a locator of its own', async () => {
    const named: WorkflowCondition = {
      kind: 'elementExists',
      target: { selector: '.d-drawer .draft-card' },
    }
    const already = await checkGoalAlreadySatisfied(
      workflowWithGoal([named], [named]),
      answering(true),
    )
    expect(already.satisfied).toBe(true)
    expect(already.note).toContain('already')
  })

  it('has no goal to confirm on a goal-less workflow', async () => {
    const already = await checkGoalAlreadySatisfied(goalless, answering(true))
    expect(already.satisfied).toBe(false)
    expect(already.evaluated).toEqual([])
  })

  it('reports the goal observation as the evidence, not the layers it never ran', async () => {
    const result = await verifyRepair(workflowWithGoal(landedEffect), noop, false, answering(true))
    expect(result.passed).toBe(true)
    expect(result.alreadySatisfied).toBe(true)
    expect(result.evaluated).toEqual({ postconditions: false, goal: true })
    expect(result.evaluatedConditions).toEqual(landedEffect)
  })

  it('makes an address-only goal run the ladder instead of skipping it', async () => {
    const result = await verifyRepair(workflowWithGoal(urlHolds), noop, false, answering(true))
    expect(result.alreadySatisfied).toBe(false)
    // L1 came from the caller, and a failing node cannot be talked around.
    expect(result.passed).toBe(false)
    expect(result.evaluated.postconditions).toBe(false)
    expect(result.evaluated.goal).toBe(true)
  })
})

describe('provesLandedEffect', () => {
  it('rejects location-only evidence and accepts everything else', () => {
    expect(provesLandedEffect({ kind: 'urlContains', value: '/publish/' })).toBe(false)
    expect(provesLandedEffect({ kind: 'urlMatches', value: '.*/publish/.*' })).toBe(false)
    expect(provesLandedEffect({ kind: 'variableExists', name: 'draftId' })).toBe(true)
    expect(
      provesLandedEffect({
        kind: 'elementVisible',
        target: { role: 'textbox', accessibleName: '标题' },
      }),
    ).toBe(true)
    expect(provesLandedEffect({ kind: 'urlChanged' })).toBe(true)
    // The document root is present before, during and after a failed step.
    expect(provesLandedEffect({ kind: 'elementExists', target: { selector: 'body' } })).toBe(false)
    expect(provesLandedEffect({ kind: 'elementVisible', target: { selector: 'HTML' } })).toBe(false)
    expect(
      provesLandedEffect({ kind: 'elementExists', target: { selector: '.save-draft' } }),
    ).toBe(true)
  })
})
