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
  goalBudgetDraftProblem,
  goalBudgetReport,
  renewIncrementOf,
  setGoalBudget,
  recordGoalRound,
  remainingGoalRounds,
  renewGoalBudget,
  archiveGoal,
  completeGoal,
  MAX_ARCHIVED_GOALS,
  startsNewGoal,
  type TaskGoal,
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

describe('renewal increment', () => {
  it('renews by one initial budget, never by the grown one', () => {
    const afterRenewal = renewGoalBudget(started(20), renewIncrementOf(started(20).goal!), 'user')
    // A second renewal must add 20 again (60), not double the current 40 (80).
    const twice = renewGoalBudget(afterRenewal, renewIncrementOf(afterRenewal.goal!), 'user')
    expect(afterRenewal.goal?.maxRounds).toBe(40)
    expect(twice.goal?.maxRounds).toBe(60)
    expect(renewIncrementOf(twice.goal!)).toBe(20)
  })

  it('follows the budget the user last set, not the budget the task started with', () => {
    // 20 → user edits to 5 → renew adds 5 (10), renew again adds 5 (15). The QA
    // case that exposed this: the card said 5 and the renewal paid out 20.
    const edited = setGoalBudget(started(20), 5)
    expect(renewIncrementOf(edited.goal!)).toBe(5)
    const renewed = renewGoalBudget(edited, renewIncrementOf(edited.goal!), 'user')
    expect(renewed.goal?.maxRounds).toBe(10)
    const twice = renewGoalBudget(renewed, renewIncrementOf(renewed.goal!), 'user')
    expect(twice.goal?.maxRounds).toBe(15)
  })

  it('falls back to the default increment for goals stored before it existed', () => {
    const goal = { ...started(20).goal!, renewIncrement: undefined }
    expect(renewIncrementOf(goal)).toBe(20)
  })
})

describe('persistence round trip', () => {
  it('keeps every goal field through save → coerceTaskProgress → load', () => {
    // The chain under test is the real one: JSON (what storage holds) →
    // coerceTaskProgress (what loadTaskProgress returns). Values are all
    // NON-default, because a default is exactly what hides a dropped field —
    // `renewIncrement` read back as the fallback 20 for an entire round.
    const base = beginTask(emptyTaskProgress('conv-rt', 1_000), 'File the report', 1_000, 7)
    const goal: TaskGoal = {
      ...base.goal!,
      renewIncrement: 3,
      roundsStarted: 2,
      status: 'paused',
      autoRenewals: 2,
      archivedAt: 5_000,
      evidence: [{ kind: 'url', value: 'https://shop.test/order/42' }],
      stagnation: {
        signature: 'sig-1',
        url: 'https://shop.test/p',
        unchanged: 1,
        unreadable: 2,
        waiting: 3,
      },
      budgetLog: [
        { at: 2_000, kind: 'edit', roundsAdded: -4, actor: 'user' },
        {
          at: 3_000,
          kind: 'auto-renew',
          roundsAdded: 7,
          actor: 'strategy',
          evidence: 'segment 1: changed',
        },
      ],
    }
    const progress: TaskProgress = {
      ...base,
      goal,
      archivedGoals: [
        {
          summary: 'Previous task',
          startedAt: 500,
          status: 'done',
          endedAt: 900,
          completedSteps: [
            { at: 600, tool: 'click', summary: 'Clicked', ok: true, url: 'https://shop.test/a' },
          ],
          autoRenewals: 1,
        },
      ],
    }

    const restored = coerceTaskProgress(JSON.parse(JSON.stringify(progress)) as unknown)

    expect(restored).toBeDefined()
    // Every goal field, not just the one that broke last time.
    for (const key of Object.keys(goal) as (keyof TaskGoal)[]) {
      expect([key, restored?.goal?.[key]]).toEqual([key, goal[key]])
    }
    expect(restored?.goal).toEqual(goal)
    expect(restored?.archivedGoals).toEqual(progress.archivedGoals)
    expect(restored?.steps).toEqual(progress.steps)
    expect(restored?.destructiveOps).toEqual(progress.destructiveOps)
    // The increment is the value the user set, not the fallback.
    expect(renewIncrementOf(restored!.goal!)).toBe(3)
  })
})

describe('budget draft validation', () => {
  it('refuses a value below the rounds already spent', () => {
    expect(goalBudgetDraftProblem('5', 20)).toBe('below-used')
    expect(goalBudgetDraftProblem('20', 20)).toBeNull()
    expect(goalBudgetDraftProblem('25', 20)).toBeNull()
  })

  it('treats empty and non-positive drafts as unusable', () => {
    expect(goalBudgetDraftProblem('', 0)).toBe('empty')
    expect(goalBudgetDraftProblem('   ', 0)).toBe('empty')
    expect(goalBudgetDraftProblem('0', 0)).toBe('invalid')
    expect(goalBudgetDraftProblem('-2', 0)).toBe('invalid')
    expect(goalBudgetDraftProblem('abc', 0)).toBe('invalid')
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

describe('goal lifecycle (R-1..R-4)', () => {
  it('a new message after a paused goal starts a fresh task', () => {
    const spent = recordGoalRound(beginTask(emptyTaskProgress('c', 1), 'task A', 1, 5), 2)
    const paused = archiveGoal(
      { ...spent, goal: { ...spent.goal!, status: 'paused' } },
      'abandoned',
    )
    expect(startsNewGoal(paused)).toBe(true)
    const next = beginTask(paused, 'task B', 3)
    expect(next.goal?.summary).toBe('task B')
    expect(next.goal?.roundsStarted).toBe(0)
    expect(next.goal?.maxRounds).toBe(20)
    expect(next.steps).toEqual([])
    expect(next.goal?.autoRenewals).toBe(0)
  })

  it('a message during an active goal continues the same task', () => {
    const active = recordGoalRound(beginTask(emptyTaskProgress('c', 1), 'task A', 1, 5), 2)
    expect(startsNewGoal(active)).toBe(false)
  })

  it('completes only on an explicit declaration with locatable evidence', () => {
    const active = beginTask(emptyTaskProgress('c', 1), 'task', 1, 5)
    // No declaration, and even "no failed steps", must NOT be treated as done.
    expect(active.goal?.status).toBe('active')
    // Empty evidence is refused.
    expect(completeGoal(active, { evidence: [] })).toBeUndefined()
    expect(completeGoal(active, { evidence: [{ kind: 'text', value: '   ' }] })).toBeUndefined()
    const done = completeGoal(active, {
      summary: 'task done',
      evidence: [
        { kind: 'url', value: 'https://example.test/order/42' },
        { kind: 'text', value: 'Order confirmed' },
      ],
    })
    expect(done?.goal?.status).toBe('done')
    expect(done?.goal?.evidence).toHaveLength(2)
  })

  it('keeps a bounded archive of finished goals', () => {
    let progress = emptyTaskProgress('c', 1)
    for (let index = 0; index < 5; index += 1) {
      progress = beginTask(progress, `task ${index}`, index, 5)
      progress = archiveGoal(progress, 'done', index + 1)
    }
    expect(progress.archivedGoals).toHaveLength(MAX_ARCHIVED_GOALS)
    expect(progress.archivedGoals?.at(-1)?.summary).toBe('task 4')
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
    expect(report?.unfinished).toEqual([])
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
