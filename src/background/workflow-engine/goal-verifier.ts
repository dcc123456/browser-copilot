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
 * The window this gate spends RE-READING a goal row that came back false.
 *
 * A success row is a claim about the page AFTER the last step, and the last step
 * of a committing workflow is a navigation: round 59 replayed 19/19, clicked
 * 「暂存离开」, and this gate read 「元素存在 草稿箱」 once, mid-navigation, while the
 * creator page was still rebuilding its menu — the run was declared failed on a
 * goal the page had already met seconds later (the repair layer's own follow-up
 * read said «goal success conditions already hold»). The certification engine
 * learned the same lesson in round 33 and got a settle window then; this earlier
 * gate decides the trial's outcome and had none.
 *
 * It is only ever paid when a row already failed, so a goal that holds costs
 * nothing extra. The gate itself defaults to `0` — a caller that reads a LIVE
 * page opts in (see `run-workflow`), so unit tests keep the pure single read.
 */
export const DEFAULT_GOAL_VERIFY_SETTLE_MS = 12_000
const DEFAULT_GOAL_VERIFY_POLL_MS = 1_500

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface GoalVerifySettleOptions {
  /** Extra window (ms) spent re-reading rows that came back unsatisfied. */
  settleMs?: number
  /** Spacing between re-reads. */
  pollMs?: number
  /** Injectable sleep (tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** A cancelled run must stop waiting, not poll a page the user abandoned. */
  signal?: AbortSignal
}

/**
 * Verify a goal spec against the live page and the run's variables.
 * Deterministic conditions decide; an unmet goal checks the terminal-state
 * conditions before giving up (alreadySatisfied — spec §8.6).
 */
export async function verifyGoalSpec(
  goal: WorkflowGoalSpec,
  deps: ConditionEvalDeps,
  llmJudge?: GoalLlmJudge,
  options: GoalVerifySettleOptions = {},
): Promise<GoalVerification> {
  const {
    settleMs = 0,
    pollMs = DEFAULT_GOAL_VERIFY_POLL_MS,
    sleep = defaultSleep,
    signal,
  } = options
  // Every row, every pass: a run whose goal failed should say WHICH rows, not
  // just the first one the short-circuit happened to stop at.
  let success = await evaluateAllConditions(goal.successConditions, deps, false)
  let settleWaitedMs = 0
  while (settleWaitedMs < settleMs && !success.allSatisfied && !signal?.aborted) {
    const slice = Math.min(pollMs, settleMs - settleWaitedMs)
    await sleep(slice)
    settleWaitedMs += slice
    success = await evaluateAllConditions(goal.successConditions, deps, false)
  }
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
