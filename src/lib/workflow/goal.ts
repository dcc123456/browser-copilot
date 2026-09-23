/**
 * Workflow goal — the "what does DONE mean" contract, pure layer.
 *
 * The goal spec lives on `settings.goalSpec` (see `lib/workflow/reliability`
 * for access + the strict gate). This module adds the pieces that stay pure:
 * normalization of untrusted goal shapes, and the derivation of a goal spec
 * from a generation draft — so a generated workflow's goal is GROUNDED in what
 * its nodes actually verify, not invented beside the graph.
 *
 * @module lib/workflow/goal
 */
import { workflowConditionsOf, type WorkflowCondition } from './conditions'
import { nodeReliabilityOf } from './reliability'
import type { WorkflowGoalSpec } from './reliability'
import type { WorkflowNode } from './types'

/**
 * Normalize an untrusted goal-spec shape: a non-empty summary and at least one
 * well-formed success condition, plus optional terminal-state conditions.
 * Garbage in → `undefined` (the strict gate then reports the missing goal).
 */
export function normalizeGoalSpec(value: unknown): WorkflowGoalSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw['summary'] !== 'string' || !raw['summary'].trim()) return undefined
  const successConditions = workflowConditionsOf(raw['successConditions'])
  if (successConditions.length === 0) return undefined
  const terminalStateConditions = workflowConditionsOf(raw['terminalStateConditions'])
  return {
    summary: raw['summary'],
    successConditions,
    ...(terminalStateConditions.length ? { terminalStateConditions } : {}),
  }
}

/** Drafts and graphs both reduce to "nodes + name" for derivation. */
export interface GoalDerivationSource {
  name: string
  nodes: Pick<WorkflowNode, 'id' | 'label' | 'data'>[]
}

/**
 * Derive a goal spec from a generated graph.
 *
 * The derivation is GROUNDED: the success conditions are exactly the
 * postconditions the nodes declare (via `__reliability`), in graph order —
 * a goal is what the graph can actually VERIFY, nothing more. A graph with no
 * postconditions derives nothing (`undefined`), which is why the generation
 * contract requires postconditions on key actions (spec §8/§12): without them
 * the workflow cannot state its own goal, and a generated-strict save is
 * blocked by the validator instead of silently claiming success.
 *
 * `goalText` (the user's request that started the generation) becomes the
 * summary when available — it is the honest statement of intent.
 */
export function deriveGoalSpecFromNodes(
  source: GoalDerivationSource,
  goalText?: string,
): WorkflowGoalSpec | undefined {
  const successConditions: WorkflowCondition[] = []
  const terminalStateConditions: WorkflowCondition[] = []
  for (const node of source.nodes) {
    const spec = nodeReliabilityOf(node as WorkflowNode)
    if (!spec) continue
    if (spec.postconditions?.length) successConditions.push(...spec.postconditions)
    // An UNSAFE action's postconditions describe the terminal state ("已登录",
    // "订单已提交") — they are exactly the already-satisfied evidence a resume
    // needs, so they double as terminal-state conditions.
    if (spec.idempotency === 'unsafe' && spec.postconditions?.length) {
      terminalStateConditions.push(...spec.postconditions)
    }
  }
  if (successConditions.length === 0) return undefined
  const summary = (goalText ?? '').trim() || source.name.trim() || '工作流目标'
  return {
    summary,
    successConditions,
    ...(terminalStateConditions.length ? { terminalStateConditions } : {}),
  }
}
