/**
 * Goal Verification — the three-level (L1/L2/L3) certification engine.
 */
import { goalSpecOf } from '../../lib/workflow/reliability'
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
  l2: { nodes: NodeVerification[]; allHeld: boolean };
  l3: { goalSummary: string; conditions: ConditionEvidence[]; allHeld: boolean };
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
  const l1: ConditionEvidence[] = nodes.map((node) => ({
    description: blockIdOf(node) + ' executed',
    satisfied: run.outcome === 'ok',
    ...(run.outcome !== 'ok' ? { detail: run.error ?? 'The run did not finish successfully.' } : {}),
  }))
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
    nodeReports.push({ nodeId: node.id, blockId: blockIdOf(node), executed: l1Pass, ...(contract ? { contract } : {}), criteria, preconditions })
  }
  const l2AllHeld = nodeReports.every((report) => report.criteria.every((c) => c.satisfied) && report.preconditions.every((c) => c.satisfied))
  const goalSpec = goalSpecOf(workflow)
  const l3Conditions: ConditionEvidence[] = []
  if (goalSpec) {
    for (const condition of goalSpec.successConditions) {
      const outcome = await evaluateCondition(condition, { variables, probe })
      l3Conditions.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
    }
  }
  const l3AllHeld = !!goalSpec && l3Conditions.length > 0 && l3Conditions.every((c) => c.satisfied)
  const passed = l1Pass && l2AllHeld && l3AllHeld
  let level: VerificationLevel = 'L1'
  if (l1Pass) level = l2AllHeld ? 'L3' : 'L2'
  const reason = !l1Pass ? 'L1 failed: one or more nodes did not execute.' : !l2AllHeld ? 'L2 failed: a node goal contract did not hold.' : !l3AllHeld ? (goalSpec ? 'L3 failed: the workflow goal success conditions did not all hold.' : 'L3 failed: the workflow has no goal contract to verify.') : 'L3 passed: the workflow achieved its goal.'
  return { level, passed, l1, l2: { nodes: nodeReports, allHeld: l2AllHeld }, l3: { goalSummary: goalSpec?.summary ?? '', conditions: l3Conditions, allHeld: l3AllHeld }, certified: passed, reason }
}