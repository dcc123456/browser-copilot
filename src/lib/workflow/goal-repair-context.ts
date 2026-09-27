/**
 * Goal-driven repair context.
 *
 * AI repair must reason from more than an error string. This module builds the
 * goal context for a failed node: the Node Goal, its Success Criteria,
 * Preconditions, Failure Meaning, captured Evidence and the Workflow Goal — so
 * the repair agent fixes the node toward its contract and verifies against it.
 *
 * The existing {@link RepairContext} shape is left untouched; this richer goal
 * context is provided alongside it (see {@link buildGoalRepairContext}).
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/goal-repair-context
 */

import type { Workflow, WorkflowNode } from './types'
import {
  nodeGoalContractOf,
  type WorkflowNodeGoalContract,
  type EvidenceSpec,
} from './node-goal-contract'
import type { WorkflowGoalSpec } from './reliability'
import { goalSpecOf } from './reliability'
import { describeCondition } from './conditions'
import type { WorkflowCondition } from './conditions'

/** The goal-driven repair context for one failed node. */
export interface GoalRepairContext {
  failedNodeId: string
  blockId?: string
  nodeGoal: string
  nodeSuccessCriteria: string[]
  preconditions: string[]
  failureMeaning: string[]
  evidence: EvidenceSpec[]
  repairHints: WorkflowNodeGoalContract['repairHints']
  workflowGoal?: WorkflowGoalSpec
  /** Raw success-criteria conditions, for any deterministic re-check. */
  rawSuccessCriteria: WorkflowCondition[]
}

/** Read the goal spec from a workflow via the reliability accessor. */
export function workflowGoalOf(workflow: Workflow): WorkflowGoalSpec | undefined {
  return goalSpecOf(workflow)
}

/**
 * Build the goal repair context for a failed node.
 *
 * When the node carries no goal contract (legacy workflow), the context
 * degrades to goal-less fields; callers decide how to handle that, but goal-
 * driven generation always supplies a contract.
 */
export function buildGoalRepairContext(
  workflow: Workflow,
  failedNode: WorkflowNode,
): GoalRepairContext {
  const contract = nodeGoalContractOf(failedNode.data)
  const blockId = typeof failedNode.data['blockId'] === 'string'
    ? (failedNode.data['blockId'] as string)
    : undefined
  return {
    failedNodeId: failedNode.id,
    blockId,
    nodeGoal: contract?.goal ?? '',
    nodeSuccessCriteria: (contract?.successCriteria ?? []).map(describeCondition),
    preconditions: (contract?.preconditions ?? []).map(describeCondition),
    failureMeaning: contract?.failureMeaning ?? [],
    evidence: contract?.evidence ?? [],
    repairHints: contract?.repairHints,
    workflowGoal: workflowGoalOf(workflow),
    rawSuccessCriteria: contract?.successCriteria ?? [],
  }
}

/** Render the goal repair context as compact text for a repair system prompt. */
export function renderGoalRepairContext(context: GoalRepairContext): string {
  const lines: string[] = []
  lines.push('NODE GOAL / 节点目标:')
  lines.push(context.nodeGoal || '(none)')
  if (context.nodeSuccessCriteria.length) {
    lines.push('SUCCESS CRITERIA / 成功标准:')
    context.nodeSuccessCriteria.forEach((item) => lines.push(`- ${item}`))
  }
  if (context.preconditions.length) {
    lines.push('PRECONDITIONS / 前置条件:')
    context.preconditions.forEach((item) => lines.push(`- ${item}`))
  }
  if (context.failureMeaning.length) {
    lines.push('FAILURE MEANING / 失败含义:')
    context.failureMeaning.forEach((item) => lines.push(`- ${item}`))
  }
  if (context.workflowGoal) {
    lines.push('WORKFLOW GOAL / 工作流目标:')
    lines.push(context.workflowGoal.summary)
  }
  return lines.join('\n')
}
