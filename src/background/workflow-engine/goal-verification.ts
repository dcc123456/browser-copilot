/**
 * Goal Verification — the three-level (L1/L2/L3) certification engine.
 */
import { goalSpecOf } from '../../lib/workflow/reliability'
import { provesLandedEffect } from '../../lib/workflow/repair-verification'
import { nodeGoalContractOf, type WorkflowNodeGoalContract } from '../../lib/workflow/node-goal-contract'
import type { Workflow, WorkflowNode } from '../../lib/workflow/types'
import { evaluateCondition, type ConditionPageProbe } from './condition-runtime'
import type { ExecuteWorkflowResult } from './run-workflow'
export type VerificationLevel = 'L1' | 'L2' | 'L3'
export interface ConditionEvidence { description: string; satisfied: boolean; detail?: string }
export interface NodeVerification {
  nodeId: string; blockId: string; executed: boolean; contract?: WorkflowNodeGoalContract;
  criteria: ConditionEvidence[]; preconditions: ConditionEvidence[]
}
export interface VerificationReport {
  level: VerificationLevel; passed: boolean;
  l1: ConditionEvidence[];
  l2: { nodes: NodeVerification[]; allHeld: boolean; /** False when NO node declared a contract: nothing was verified here. */ evaluated?: boolean };
  l3: { goalSummary: string; conditions: ConditionEvidence[]; allHeld: boolean };
  /** Soft postconditions the run reported — they never fail a step, but they bar certification. */
  softUnconfirmed?: string[];
  certified: boolean; reason: string
}
function isActionNode(node: WorkflowNode): boolean {
  return typeof node.data?.blockId === 'string' && node.data.blockId !== 'trigger'
}
function blockIdOf(node: WorkflowNode): string {
  return typeof node.data?.blockId === 'string' ? node.data.blockId : 'unknown'
}
export async function verifyWorkflowGoal(workflow: Workflow, run: ExecuteWorkflowResult, probe: ConditionPageProbe): Promise<VerificationReport> {
  const nodes = workflow.drawflow.nodes.filter(isActionNode)
  const variables = run.variables ?? {}
  // L1 is per-node evidence, not the run's verdict: a step skipped by a branch
  // or swallowed by `onError: continue` did NOT execute, and calling it
  // executed is how a half-run gets a certificate. `completedNodeIds` is the
  // engine's own list; without it there is no per-node truth to report, so the
  // run outcome is all we honestly have.
  const completed = run.completedNodeIds ? new Set(run.completedNodeIds) : undefined
  const l1: ConditionEvidence[] = nodes.map((node) => {
    const executed = completed ? completed.has(node.id) : run.outcome === 'ok'
    return {
      description: blockIdOf(node) + ' executed',
      satisfied: executed,
      ...(!executed
        ? { detail: run.error ?? (completed ? 'The step never ran.' : 'The run did not finish successfully.') }
        : {}),
    }
  })
  const l1Pass = run.outcome === 'ok' && l1.every((c) => c.satisfied)
  const nodeReports: NodeVerification[] = []
  for (const node of nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>
    const contract = nodeGoalContractOf(data)
    const criteria: ConditionEvidence[] = []
    const preconditions: ConditionEvidence[] = []
    if (contract) {
      for (const condition of contract.successCriteria) {
        const outcome = await evaluateCondition(condition, { variables, probe })
        criteria.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
      }
      for (const condition of contract.preconditions ?? []) {
        const outcome = await evaluateCondition(condition, { variables, probe })
        preconditions.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
      }
    }
    nodeReports.push({ nodeId: node.id, blockId: blockIdOf(node), executed: completed ? completed.has(node.id) : l1Pass, ...(contract ? { contract } : {}), criteria, preconditions })
  }
  // `every` over nodes with nothing to check is vacuously true — that is not
  // verification, it is the absence of evidence. Report whether L2 was
  // evaluated at all so no consumer reads an empty ballot as a pass.
  const l2Evaluated = nodeReports.some((report) => report.criteria.length > 0 || report.preconditions.length > 0)
  const l2AllHeld = nodeReports.every((report) => report.criteria.every((c) => c.satisfied) && report.preconditions.every((c) => c.satisfied))
  const goalSpec = goalSpecOf(workflow)
  const l3Conditions: ConditionEvidence[] = []
  // A URL row says where the run IS, not what it DID, and a graph that opens the
  // publish page satisfies `/publish` before its first step. S0 already refuses
  // that as evidence (see `provesLandedEffect`); L3 has to use the same standard
  // or a replay that clicked nothing certifies its own goal.
  let l3EffectProven = false
  if (goalSpec) {
    for (const condition of goalSpec.successConditions) {
      const outcome = await evaluateCondition(condition, { variables, probe })
      l3Conditions.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
      if (outcome.satisfied && provesLandedEffect(condition)) l3EffectProven = true
    }
  }
  const l3AllHeld = !!goalSpec && l3Conditions.length > 0 && l3Conditions.every((c) => c.satisfied) && l3EffectProven
  // Soft postconditions (business-outcome predictions the generator wrote): a
  // miss never failed the step, but a run whose declared outcomes were not
  // observed cannot be certified. This is D3 — signal, not gate.
  const softUnconfirmed = run.conditionWarnings ?? []
  const passed = l1Pass && l2AllHeld && l3AllHeld && softUnconfirmed.length === 0
  // `level` is the deepest layer the verification REACHED, not a badge: L3 is
  // only reached when a goal with conditions was actually evaluated. Claiming
  // 'L3' for a workflow that never got that far (an empty L2 ballot used to
  // grant it) is the label bug this replaces.
  const l3Evaluated = !!goalSpec && l3Conditions.length > 0
  let level: VerificationLevel = 'L1'
  if (l1Pass) level = l2AllHeld && l3Evaluated ? 'L3' : 'L2'
  const reason = !l1Pass
    ? 'L1 failed: one or more nodes did not execute.'
    : !l3AllHeld
      ? !goalSpec
        ? 'L3 failed: the workflow has no goal contract to verify.'
        : l3Evaluated && l3Conditions.every((c) => c.satisfied)
          ? 'L3 failed: every success condition holds from the page the workflow opens (a URL row), so none of them proves the goal landed.'
          : 'L3 failed: the workflow goal success conditions did not all hold.'
      : !l2AllHeld
        ? 'L2 failed: a node goal contract did not hold.'
        : softUnconfirmed.length > 0
          ? `Goal conditions held, but ${softUnconfirmed.length} declared outcome(s) were not confirmed on the page.`
          : 'L3 passed: the workflow achieved its goal.'
  return { level, passed, l1, l2: { nodes: nodeReports, allHeld: l2AllHeld, evaluated: l2Evaluated }, l3: { goalSummary: goalSpec?.summary ?? '', conditions: l3Conditions, allHeld: l3AllHeld }, softUnconfirmed, certified: passed, reason }
}