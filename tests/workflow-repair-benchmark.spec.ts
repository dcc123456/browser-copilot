/**
 * Offline autonomous-repair benchmark (spec §37.2, metrics R1–R4).
 *
 * Deterministic simulation of the policy ladder walk: for each repair case we
 * ask the pure policy for strategies in order and replay scripted per-
 * strategy outcomes (success / no-candidate / verification-failed / blocked),
 * then derive the metrics. No model, no browser — the benchmark measures the
 * orchestration logic (ladder advance, exhaustion, blocking) itself.
 */
import { describe, expect, it } from 'vitest'
import {
  beginAttempt,
  finishAttempt,
  startRepairSession,
} from '../src/lib/workflow/repair-session'
import type {
  FailureSnapshot,
  RepairAttempt,
  RepairSession,
} from '../src/lib/workflow/repair-session'
import { nextStrategyOf } from '../src/lib/workflow/repair-policy'

type StrategyOutcome = 'success' | 'no-candidate' | 'verification-failed' | 'blocked'

interface RepairCase {
  name: string
  failureType: FailureSnapshot['errorType']
  failedNodeId: string
  /** Scripted outcomes per strategy; unspecified = no-candidate. */
  outcomes: Partial<Record<RepairAttempt['strategy'], StrategyOutcome>>
  /** True when success is expected (the run recovered automatically). */
  expectSuccess: boolean
}

const CASES: RepairCase[] = [
  {
    name: 'R-case-1 locator works on first model strategy',
    failureType: 'ELEMENT_NOT_FOUND',
    failedNodeId: 'n2',
    outcomes: {
      'terminal-state-check': 'no-candidate',
      'locator-repair': 'success',
    },
    expectSuccess: true,
  },
  {
    name: 'R-case-2 readiness then parameter success',
    failureType: 'INPUT_REJECTED',
    failedNodeId: 'n3',
    outcomes: {
      'terminal-state-check': 'no-candidate',
      'parameter-repair': 'success',
    },
    expectSuccess: true,
  },
  {
    name: 'R-case-3 escalates through local graph to section replan',
    failureType: 'STATE_MISMATCH',
    failedNodeId: 'n4',
    outcomes: {
      'terminal-state-check': 'no-candidate',
      'local-graph-repair': 'verification-failed',
      'section-replan': 'success',
    },
    expectSuccess: true,
  },
  {
    name: 'R-case-4 captcha is a genuine blocker',
    failureType: 'CAPTCHA_REQUIRED',
    failedNodeId: 'n1',
    outcomes: {},
    expectSuccess: false,
  },
  {
    name: 'R-case-5 every strategy dead-ends: exhausted',
    failureType: 'GOAL_NOT_SATISFIED',
    failedNodeId: 'n5',
    outcomes: {}, // all strategies no-candidate
    expectSuccess: false,
  },
]

function snapshotFor(testCase: RepairCase): FailureSnapshot {
  return {
    nodeId: testCase.failedNodeId,
    blockId: 'click',
    errorType: testCase.failureType,
    errorMessage: testCase.name,
    page: {},
  }
}

interface CaseResult {
  name: string
  status: 'success' | 'exhausted' | 'blocked'
  attempts: number
  noCandidateCount: number
  strategySuccess?: RepairAttempt['strategy']
}

function runCase(testCase: RepairCase, index: number): CaseResult {
  const failure = snapshotFor(testCase)
  let session: RepairSession = startRepairSession({
    workflowId: `wf-${index}`,
    runId: `run-${index}`,
    failedNodeId: testCase.failedNodeId,
    fingerprint: `fp-${index}`,
    failure,
    startedAt: 1000 + index,
  })

  let modelCalls = 0
  let noCandidateCount = 0

  // Policy loop (mirrors the orchestrator's decision points, offline).
  for (;;) {
    const decision = nextStrategyOf({
      failureType: failure.errorType,
      attempts: session.attempts,
      budget: session.budget,
      modelCalls,
      startedAt: 1000 + index,
      now: 1000 + index + session.attempts.length,
    })

    if (decision.kind === 'blocked') {
      return {
        name: testCase.name,
        status: 'blocked',
        attempts: session.attempts.length,
        noCandidateCount,
      }
    }
    if (decision.kind === 'exhausted') {
      return {
        name: testCase.name,
        status: 'exhausted',
        attempts: session.attempts.length,
        noCandidateCount,
      }
    }

    const strategy = decision.strategy
    session = beginAttempt(session, strategy)
    // Count model usage.
    if (strategy !== 'terminal-state-check' && strategy !== 'readiness-recovery') {
      modelCalls += 1
    }

    const outcome: StrategyOutcome = testCase.outcomes[strategy] ?? 'no-candidate'
    if (outcome === 'success') {
      session = finishAttempt(session, {}, 'verified')
      return {
        name: testCase.name,
        status: 'success',
        attempts: session.attempts.length,
        noCandidateCount,
        strategySuccess: strategy,
      }
    }
    if (outcome === 'blocked') {
      session = finishAttempt(session, {}, 'verification-failed')
      return {
        name: testCase.name,
        status: 'blocked',
        attempts: session.attempts.length,
        noCandidateCount,
      }
    }
    if (outcome === 'verification-failed') {
      session = finishAttempt(session, {}, 'verification-failed')
    } else {
      noCandidateCount += 1
      session = finishAttempt(session, {}, 'no-candidate')
    }
  }
}

describe('workflow repair benchmark (R1–R4)', () => {
  it('reports the offline repair metrics', () => {
    const results = CASES.map((testCase, index) => runCase(testCase, index))

    const triggered = results.length
    const autoRepaired = results.filter((r) => r.status === 'success').length
    const totalAttempts = results.reduce((sum, r) => sum + r.attempts, 0)
    const noCandidates = results.reduce((sum, r) => sum + r.noCandidateCount, 0)
    const necessaryBlockers = results.filter((r) => r.status === 'blocked').length
    const exhausted = results.filter((r) => r.status === 'exhausted').length

    // R1 Auto repair success rate.
    const r1 = autoRepaired / triggered
    // R3 no-candidate rate (over all attempts).
    const r3 = noCandidates / totalAttempts
    // R4 split human takeover: necessary blocker vs exhausted.
    const r4 = {
      necessaryBlockerTakeovers: necessaryBlockers,
      repairExhaustedTakeovers: exhausted,
      total: necessaryBlockers + exhausted,
    }

    // R2 per-strategy success rate: which strategy delivered each fix.
    const r2 = results
      .filter((r) => r.strategySuccess)
      .reduce<Record<string, number>>((acc, r) => {
        const key = r.strategySuccess!
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {})

    const metrics = {
      R1_autoRepairSuccessRate: round(r1),
      R2_firstStrategySuccessByStrategy: r2,
      R3_noCandidateRate: round(r3),
      R4_humanTakeover: r4,
      triggeredRuns: triggered,
    }
    // eslint-disable-next-line no-console
    console.log('\n[workflow-repair benchmark]\n' + JSON.stringify(metrics, null, 2))

    // Three scripted recoveries, one genuine blocker, one exhaustion.
    expect(r1).toBeGreaterThanOrEqual(0.6)
    expect(necessaryBlockers).toBe(1)
    expect(exhausted).toBe(1)
    // The captcha case blocked WITHOUT consuming ladder attempts.
    const captcha = results.find((r) => r.name.includes('captcha'))
    expect(captcha?.status).toBe('blocked')
    expect(captcha?.attempts).toBe(0)
    // Exhausted case reached the end through dead-ends, never a direct
    // takeover after a single no-candidate.
    const exhaustedCase = results.find((r) => r.name.includes('exhausted'))
    expect(exhaustedCase?.attempts).toBeGreaterThan(1)
  })
})

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
