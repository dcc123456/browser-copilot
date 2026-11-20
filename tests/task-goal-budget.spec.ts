/**
 * R10 goal object: explicit budget, incremental renewal, and the K rules for
 * unattended auto-renewal. Pure model only — the loop wiring and the panel card
 * render these facts, they do not invent their own.
 */
import { describe, expect, it } from 'vitest'
import {
  autoRenewDecision,
  beginTask,
  coerceTaskProgress,
  emptyTaskProgress,
  goalBudgetExhausted,
  goalBudgetReport,
  recordGoalRound,
  remainingGoalRounds,
  renewGoalBudget,
  type TaskProgress,
} from '../src/lib/task-progress'

function started(maxRounds = 3) {
  return beginTask(emptyTaskProgress('conv-1', 1_000), 'File the report', 1_000, maxRounds)
}

describe('goal budget', () => {
  it('defaults to an explicit budget and counts spent rounds', () => {
    const goal = started()
    expect(goal.goal?.maxRounds).toBe(3)
    expect(remainingGoalRounds(goal)).toBe(3)
    const spent = recordGoalRound(recordGoalRound(goal, 2_000), 3_000)
    expect(spent.goal?.roundsStarted).toBe(2)
    expect(remainingGoalRounds(spent)).toBe(1)
    expect(goalBudgetExhausted(spent)).toBe(false)
    expect(goalBudgetExhausted(recordGoalRound(spent, 4_000))).toBe(true)
  })

  it('renews by an increment without resetting spent rounds', () => {
    const paused = { ...started(), goal: { ...started().goal!, status: 'paused' as const } }
    const renewed = renewGoalBudget(paused, 5, 'user', 2_000)
    expect(renewed.goal?.maxRounds).toBe(8)
    // CRITICAL: renewal extends the same task — spent rounds and the step list
    // stay, so the stagnation counter kept alongside the goal survives too.
    expect(renewed.goal?.roundsStarted).toBe(0)
    expect(renewed.goal?.status).toBe('active')
    expect(renewed.goal?.budgetLog).toHaveLength(1)
    expect(renewed.goal?.budgetLog[0]).toMatchObject({
      kind: 'renew',
      actor: 'user',
      roundsAdded: 5,
    })
  })

  it('refuses a non-positive renewal', () => {
    const before = started()
    expect(renewGoalBudget(before, 0, 'user').goal?.maxRounds).toBe(before.goal?.maxRounds)
    expect(renewGoalBudget(before, Number.NaN, 'user').goal?.maxRounds).toBe(before.goal?.maxRounds)
  })
})

describe('auto-renewal K (unattended only)', () => {
  const paused = () => {
    const base = started(1)
    const spent = recordGoalRound(base, 2_000)
    return { ...spent, goal: { ...spent.goal!, status: 'paused' as const } }
  }

  it('never renews while a human is present', () => {
    expect(
      autoRenewDecision(paused(), { unattended: false, k: 1, progressDetected: true }),
    ).toEqual({ allowed: false, reason: 'attended' })
  })

  it('never renews without progress in the segment that just ran', () => {
    expect(
      autoRenewDecision(paused(), { unattended: true, k: 1, progressDetected: false }),
    ).toEqual({ allowed: false, reason: 'no-progress' })
  })

  it('allows exactly K auto-renewals, each logged with evidence', () => {
    expect(autoRenewDecision(paused(), { unattended: true, k: 1, progressDetected: true })).toEqual(
      {
        allowed: true,
        reason: 'allowed',
      },
    )
    const renewed = renewGoalBudget(paused(), 2, 'strategy', 3_000, 'page 3 opened')
    const log = renewed.goal?.budgetLog ?? []
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      kind: 'auto-renew',
      actor: 'strategy',
      evidence: 'page 3 opened',
    })
    // Budget exhausted again, same K: no second automatic renewal.
    const again = { ...renewed, goal: { ...renewed.goal!, status: 'paused' as const } }
    expect(autoRenewDecision(again, { unattended: true, k: 1, progressDetected: true })).toEqual({
      allowed: false,
      reason: 'k-exhausted',
    })
  })

  it('K = 0 disables auto-renewal entirely', () => {
    expect(autoRenewDecision(paused(), { unattended: true, k: 0, progressDetected: true })).toEqual(
      {
        allowed: false,
        reason: 'k-exhausted',
      },
    )
  })
})

describe('K quota counter (QA audit)', () => {
  it('keeps blocking after more renewals than the bounded log can hold', () => {
    // K > MAX_BUDGET_LOG used to be unreachable: the quota was derived from the
    // 20-entry log, so `used` never reached the cap. The monotonic counter fixes
    // it; this asserts the 25th renewal is still refused at K = 25.
    const paused = () => {
      const spent = recordGoalRound(started(1), 2_000)
      return { ...spent, goal: { ...spent.goal!, status: 'paused' as const } }
    }
    let progress: TaskProgress = paused()
    for (let index = 0; index < 25; index += 1) {
      const decision = autoRenewDecision(progress, {
        unattended: true,
        k: 25,
        progressDetected: true,
      })
      expect(decision.allowed).toBe(true)
      progress = renewGoalBudget(progress, 1, 'strategy', 3_000 + index, 'progress')
      progress = { ...progress, goal: { ...progress.goal!, status: 'paused' as const } }
    }
    expect(progress.goal?.autoRenewals).toBe(25)
    expect(
      autoRenewDecision(progress, { unattended: true, k: 25, progressDetected: true }),
    ).toEqual({
      allowed: false,
      reason: 'k-exhausted',
    })
    // The display log stays bounded while the quota is not.
    expect(progress.goal?.budgetLog.length).toBeLessThanOrEqual(20)
  })
})

describe('goal report and migration', () => {
  it('reports the six budget facts including the next actions', () => {
    const progress = recordGoalRound(
      beginTask(emptyTaskProgress('conv-1', 1_000), 'File the report', 1_000, 2),
      2_000,
    )
    const report = goalBudgetReport(progress, {
      inputTokens: 1_200,
      cachedInputTokens: 900,
      outputTokens: 40,
      requests: 2,
    })
    expect(report).toMatchObject({
      goal: 'File the report',
      completed: 0,
      usedRounds: 1,
      maxRounds: 2,
      remainingRounds: 1,
      stopReason: 'budget',
      nextActions: ['renew', 'change-goal', 'stop'],
    })
    // Six items: goal, done (with evidence), unfinished, stop reason, cost,
    // next actions. The report is the single source for the pause card.
    expect(report?.completedSteps).toEqual([])
    expect(report?.unfinished).toEqual(['Continue the goal from the last completed step.'])
  })

  it('restores autoRenewals and stagnation from storage instead of zeroing them', () => {
    const restored = coerceTaskProgress({
      version: 2,
      conversationId: 'conv-1',
      goal: {
        summary: 'goal',
        startedAt: 10,
        maxRounds: 40,
        roundsStarted: 12,
        status: 'paused',
        budgetLog: [],
        autoRenewals: 3,
        stagnation: {
          signature: 'SIG',
          url: 'https://x.test/p',
          unchanged: 5,
          unreadable: 0,
          waiting: 1,
        },
      },
      steps: [],
      destructiveOps: [],
      updatedAt: 20,
    })
    expect(restored?.goal?.autoRenewals).toBe(3)
    expect(restored?.goal?.stagnation).toEqual({
      signature: 'SIG',
      url: 'https://x.test/p',
      unchanged: 5,
      unreadable: 0,
      waiting: 1,
    })
  })

  it('migrates a version-1 record with the default budget instead of dropping it', () => {
    const migrated = coerceTaskProgress({
      version: 1,
      conversationId: 'conv-1',
      goal: { summary: 'old goal', startedAt: 10 },
      steps: [],
      destructiveOps: [],
      updatedAt: 20,
    })
    expect(migrated?.version).toBe(2)
    expect(migrated?.goal).toMatchObject({ summary: 'old goal', maxRounds: 20, roundsStarted: 0 })
  })
})
