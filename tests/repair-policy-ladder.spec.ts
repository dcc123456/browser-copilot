import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPAIR_BUDGET,
} from '../src/lib/workflow/repair-session'
import type { RepairAttempt } from '../src/lib/workflow/repair-session'
import {
  isEscalation,
  ladderForFailure,
  localRepairWindow,
  nextStrategyOf,
  strategyUsesModel,
} from '../src/lib/workflow/repair-policy'

const startedAt = 1_000_000

function attempt(partial: Partial<RepairAttempt> & { strategy: RepairAttempt['strategy'] }): RepairAttempt {
  return {
    attempt: 1,
    outcome: 'no-candidate',
    startedAt,
    ...partial,
  }
}

describe('repair policy ladder', () => {
  it('blocks external gates immediately', () => {
    for (const type of ['AUTH_REQUIRED', 'CAPTCHA_REQUIRED', 'MFA_REQUIRED'] as const) {
      const result = nextStrategyOf({
        failureType: type,
        attempts: [],
        budget: DEFAULT_REPAIR_BUDGET,
        modelCalls: 0,
        startedAt,
        now: startedAt,
      })
      expect(result.kind).toBe('blocked')
    }
  })

  it('blocks side-effect-unknown replays', () => {
    const result = nextStrategyOf({
      failureType: 'SIDE_EFFECT_UNKNOWN',
      attempts: [],
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: 0,
      startedAt,
      now: startedAt,
    })
    expect(result.kind).toBe('blocked')
  })

  it('offers terminal-state then the preferred strategy for an element failure', () => {
    const ladder = ladderForFailure('ELEMENT_NOT_FOUND')
    expect(ladder[0]).toBe('terminal-state-check')
    expect(ladder[1]).toBe('locator-repair')
  })

  it('advances to the next strategy after a no-candidate attempt', () => {
    const first = nextStrategyOf({
      failureType: 'ELEMENT_NOT_FOUND',
      attempts: [],
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: 0,
      startedAt,
      now: startedAt,
    })
    expect(first).toMatchObject({ kind: 'next', strategy: 'terminal-state-check' })

    const second = nextStrategyOf({
      failureType: 'ELEMENT_NOT_FOUND',
      attempts: [attempt({ strategy: 'terminal-state-check' })],
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: 0,
      startedAt,
      now: startedAt + 100,
    })
    expect(second).toMatchObject({ kind: 'next', strategy: 'terminal-state-check' })

    const third = nextStrategyOf({
      failureType: 'ELEMENT_NOT_FOUND',
      attempts: [
        attempt({ attempt: 1, strategy: 'terminal-state-check' }),
        attempt({ attempt: 2, strategy: 'terminal-state-check' }),
      ],
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: 0,
      startedAt,
      now: startedAt + 200,
    })
    expect(third).toMatchObject({ kind: 'next', strategy: 'locator-repair' })
  })

  it('never treats an empty ladder as a human takeover — it is exhausted', () => {
    const ladder = ladderForFailure('ELEMENT_NOT_FOUND')
    const attempts = ladder.map((strategy, index) =>
      attempt({ attempt: index + 1, strategy }),
    )
    const result = nextStrategyOf({
      failureType: 'ELEMENT_NOT_FOUND',
      attempts,
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: DEFAULT_REPAIR_BUDGET.maxModelCalls,
      startedAt,
      now: startedAt + 100,
    })
    expect(result.kind === 'blocked' ? result.reason : '').not.toMatch(/human/i)
    expect(['exhausted', 'next']).toContain(result.kind)
  })

  it('respects the duration budget', () => {
    const result = nextStrategyOf({
      failureType: 'ELEMENT_NOT_FOUND',
      attempts: [],
      budget: DEFAULT_REPAIR_BUDGET,
      modelCalls: 0,
      startedAt,
      now: startedAt + DEFAULT_REPAIR_BUDGET.maxTotalDurationMs,
    })
    expect(result).toMatchObject({ kind: 'exhausted' })
  })

  it('bounds the local repair window', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5']
    const window = localRepairWindow(ids, 'n3', 1)
    expect([...window]).toEqual(['n2', 'n3', 'n4'])
  })

  it('flags model use and escalation direction', () => {
    expect(strategyUsesModel('locator-repair')).toBe(true)
    expect(strategyUsesModel('readiness-recovery')).toBe(false)
    expect(isEscalation('full-workflow-replan')).toBe(true)
    expect(isEscalation('terminal-state-check')).toBe(false)
  })
})
