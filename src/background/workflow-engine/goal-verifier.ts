/**
 * The goal verifier — deterministic verification of a workflow's goal spec.
 *
 * Priority order (spec §8.5):
 *   1. deterministic conditions (this module — page/URL/variable checks);
 *   2. terminal-state conditions ("already satisfied") for non-idempotent
 *      goals — the goal END STATE may hold even though this run never
 *      re-demonstrated it (you cannot log in again to prove the first login);
 *   3. an LLM goal judge as FALLBACK — and even then only as a signal, never
 *      alone: no condition evidence, no success.
 *
 * v1 implements 1 + 2. The LLM fallback hook exists (`llmJudge`) and its
 * contract is strict: it can only CORROBORATE an unverifiable-but-plausible
 * result, it can never overturn a deterministic failure without evidence.
 *
 * @module background/workflow-engine/goal-verifier
 */
import type { WorkflowGoalSpec } from '../../lib/workflow/reliability'
import { evaluateAllConditions, type ConditionEvalDeps } from './condition-runtime'

/** The deterministic goal verification result. */
export interface GoalVerification {
  /** The goal is achieved (conditions hold, or the terminal state already does). */
  achieved: boolean
  /** The goal was achieved via terminal-state conditions (already-done), not this run. */
  alreadySatisfied?: boolean
  /** Descriptions of the unmet conditions (failure evidence). */
  unmet: string[]
  /** One-line basis of the verdict (for run logs and the panel). */
  note: string
}

/** Optional LLM corroboration hook (see module docblock for the strict contract). */
export type GoalLlmJudge = (
  goal: WorkflowGoalSpec,
  unmet: string[],
) => Promise<{ plausible: boolean; note: string } | null>

/**
 * Verify a goal spec against the live page and the run's variables.
 * Deterministic conditions decide; an unmet goal checks the terminal-state
 * conditions before giving up (alreadySatisfied — spec §8.6).
 */
export async function verifyGoalSpec(
  goal: WorkflowGoalSpec,
  deps: ConditionEvalDeps,
  llmJudge?: GoalLlmJudge,
): Promise<GoalVerification> {
  const success = await evaluateAllConditions(goal.successConditions, deps)
  if (success.allSatisfied) {
    return { achieved: true, unmet: [], note: `目标达成：${goal.summary}` }
  }
  const unmet = success.outcomes.filter((o) => !o.satisfied).map((o) => o.description)

  // Terminal state first: a non-idempotent goal that ALREADY holds counts —
  // the run cannot re-demonstrate it, and demanding it would push the runtime
  // into re-executing an unsafe action (the exact bug class Phase 9 blocks).
  if (goal.terminalStateConditions?.length) {
    const terminal = await evaluateAllConditions(goal.terminalStateConditions, deps)
    if (terminal.allSatisfied) {
      return {
        achieved: true,
        alreadySatisfied: true,
        unmet,
        note: `终态已满足（动作早已发生）：${goal.summary}`,
      }
    }
  }

  // LLM corroboration can never fake evidence: it may only mark a goal
  // "plausibly achieved" when the deterministic layer says otherwise AND the
  // caller accepts that weakened verdict. Deterministic failure + no judge
  // (or a negative judge) = goal NOT achieved, fail closed.
  if (llmJudge) {
    try {
      const verdict = await llmJudge(goal, unmet)
      if (verdict?.plausible) {
        return {
          achieved: false,
          unmet,
          note: `条件未满足，但模型判断可能已达成（不可作为成功依据）：${verdict.note}`,
        }
      }
    } catch {
      // judge unavailable → fail closed below
    }
  }
  return {
    achieved: false,
    unmet,
    note: `目标未达成：${unmet.join('；')}`,
  }
}
