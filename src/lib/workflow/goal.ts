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
import { conditionRequiresBaseline } from './conditions'
import { provesLandedEffect } from './repair-verification'
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

/** Whole-token `indexOf`: `noteTitle` must not match inside `noteTitleActual`. */
function mentionsName(haystack: string, name: string): boolean {
  const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(name, from)
    if (at === -1) return false
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + name.length])) return true
    from = at + name.length
  }
}

/**
 * Ground a goal-first contract in the graph that was actually built.
 *
 * `prepare_workflow_goal` runs on the FIRST turn, before a single node exists,
 * so its success conditions name the variables the model EXPECTED to write. The
 * graph then writes its own (`xhsTitle`, `noteBody`, …), and a 「变量
 * xiaohongshuTitle 存在」 row can never hold: the replay runs 26/26 clean, the
 * goal is permanently uncertifiable, and the one number everyone was supposed to
 * trust becomes the thing you learn to ignore. An unverifiable row is not a
 * strict goal — it is a broken instrument, and a broken instrument reads false
 * even when the goal landed.
 *
 * The test is deliberately the WEAKEST claim of "this graph knows the name":
 * the name appears anywhere in a node's data, or is declared as a run input.
 * An exact producer-field whitelist would be stricter, but the set of blocks
 * that write a variable is wider than any list here keeps current (see
 * `VARIABLE_PRODUCER_FIELD`, which had already drifted once) — and a row that
 * drops a checkable goal is a silent weakening, while a row kept on a name the
 * graph genuinely writes can still fail on its merits.
 *
 * Dropping loses evidence, so the graph's own verified postconditions
 * (`deriveGoalSpecFromNodes`) fill in, and they are added only as needed to
 * restore a landed-effect proof — a URL row cannot be that proof, and a goal
 * reduced to one is not a goal. If the graph offers nothing, the contract is
 * returned untouched: better a loud, permanent failure than a certificate for a
 * run that did nothing.
 */
export function groundGoalSpecToGraph(
  goalSpec: WorkflowGoalSpec,
  source: GoalDerivationSource,
): { goalSpec: WorkflowGoalSpec; dropped: WorkflowCondition[] } {
  const nodes = source.nodes
  const isTrigger = (node: Pick<WorkflowNode, 'data'>): boolean => node.data?.['blockId'] === 'trigger'
  const haystack = [
    nodes.filter((node) => !isTrigger(node)).map((node) => JSON.stringify(node.data ?? {})).join('\n'),
    JSON.stringify(nodes.find(isTrigger)?.data?.['parameters'] ?? ''),
  ].join('\n')

  const dropped: WorkflowCondition[] = []
  const kept = goalSpec.successConditions.filter((condition) => {
    if (condition.kind !== 'variableExists' && condition.kind !== 'variableEquals') return true
    if (mentionsName(haystack, condition.name)) return true
    dropped.push(condition)
    return false
  })
  if (dropped.length === 0) return { goalSpec, dropped: [] }

  const successConditions = [...kept]
  if (!successConditions.some(provesLandedEffect)) {
    for (const condition of deriveGoalSpecFromNodes(source)?.successConditions ?? []) {
      // A row that compares against an observation from BEFORE its step is not
      // checkable once the run is over (see `conditionRequiresBaseline`), so
      // installing one as the replacement proof would recreate the very defect
      // grounding removes: a goal that reads false no matter what happened.
      if (conditionRequiresBaseline(condition)) continue
      if (successConditions.some((c) => JSON.stringify(c) === JSON.stringify(condition))) continue
      successConditions.push(condition)
      if (successConditions.some(provesLandedEffect)) break
    }
  }
  if (successConditions.length === 0) return { goalSpec, dropped: [] }
  return {
    goalSpec: {
      summary: goalSpec.summary,
      successConditions,
      ...(goalSpec.terminalStateConditions?.length
        ? { terminalStateConditions: goalSpec.terminalStateConditions }
        : {}),
    },
    dropped,
  }
}
