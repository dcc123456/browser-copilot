/**
 * Generation attempt record, scorer and summary tests.
 *
 * These pin the contract later Best-of-N / corpus work builds on: the five
 * score components (and the goal credit's replay gate), the pass rule, the
 * failure-kind priority, the merge semantics, and the two interval helpers the
 * report prints. A weight change is meant to fail here — and in the committed
 * fixture comparison — rather than silently move the baseline.
 */
import { describe, expect, it } from 'vitest'

import {
  ATTEMPT_SCORE_WEIGHTS,
  attemptPasses,
  bootstrapMeanInterval,
  failureKindOfAttempt,
  failureKindOfCode,
  mergeGenerationAttempt,
  normalizeGenerationAttempt,
  scoreGenerationAttempt,
  summarizeGenerationAttempts,
  wilsonInterval,
} from '../src/lib/workflow/generation-attempt'

import type {
  ComposeFacts,
  GenerationAttemptRecord,
  ReplayFacts,
} from '../src/lib/workflow/generation-attempt'

function composeFacts(overrides: Partial<ComposeFacts> = {}): ComposeFacts {
  return {
    saved: true,
    nodeCount: 5,
    staticOk: true,
    staticCodes: [],
    staticErrorCount: 0,
    staticWarningCount: 0,
    trial: { outcome: 'passed', full: true, coveredSteps: 5, totalSteps: 5 },
    ...overrides,
  }
}

function replayFacts(overrides: Partial<ReplayFacts> = {}): ReplayFacts {
  return {
    ran: true,
    ok: true,
    verified: true,
    proven: true,
    outcome: 'ok',
    coveredSteps: 5,
    totalSteps: 5,
    ...overrides,
  }
}

function attempt(overrides: Partial<GenerationAttemptRecord> = {}): GenerationAttemptRecord {
  return {
    at: 1,
    attemptId: 'attempt-1',
    compose: composeFacts(),
    replay: replayFacts(),
    pass: true,
    score: 1,
    ...overrides,
  }
}

describe('generation attempt scoring', () => {
  const weights = ATTEMPT_SCORE_WEIGHTS

  it('keeps the five planned weights', () => {
    expect(weights).toEqual({
      saved: 0.1,
      staticChecks: 0.15,
      trialProgress: 0.15,
      replayVerified: 0.2,
      goal: 0.4,
    })
    const sum =
      weights.saved +
      weights.staticChecks +
      weights.trialProgress +
      weights.replayVerified +
      weights.goal
    expect(Math.round(sum * 1000) / 1000).toBe(1)
  })

  it('scores each compose component independently', () => {
    expect(
      scoreGenerationAttempt({
        compose: composeFacts({ saved: true, staticOk: false, trial: undefined }),
      }),
    ).toBe(0.1)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts({ saved: false, staticOk: true, trial: undefined }),
      }),
    ).toBe(0.15)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts({
          saved: false,
          staticOk: false,
          trial: { outcome: 'partial', full: false, coveredSteps: 3, totalSteps: 4 },
        }),
      }),
    ).toBe(0.112)
    expect(
      scoreGenerationAttempt({ compose: composeFacts({ saved: false, staticOk: false }) }),
    ).toBe(0.15)
  })

  it('scores a verified replay and gates the goal credit behind it', () => {
    expect(scoreGenerationAttempt({ compose: composeFacts(), replay: replayFacts() })).toBe(0.6)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'L3', certified: true, unmetCount: 0 } }),
      }),
    ).toBe(1)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'L2', certified: true, unmetCount: 0 } }),
      }),
    ).toBe(0.84)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'L1', certified: true, unmetCount: 0 } }),
      }),
    ).toBe(0.72)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'NONE', certified: false, unmetCount: 0 } }),
      }),
    ).toBe(0.6)
    expect(
      scoreGenerationAttempt({
        compose: composeFacts(),
        replay: replayFacts({
          verified: false,
          goal: { level: 'L3', certified: true, unmetCount: 0 },
        }),
      }),
    ).toBe(0.4)
  })

  it('uses replay progress over the compose trial once a replay exists', () => {
    expect(
      scoreGenerationAttempt({
        compose: composeFacts({
          trial: { outcome: 'passed', full: true, coveredSteps: 5, totalSteps: 5 },
        }),
        replay: replayFacts({ verified: false, ok: false, coveredSteps: 1, totalSteps: 4 }),
      }),
    ).toBe(0.288)
  })

  it('clamps progress to the documented 0..1 range', () => {
    expect(
      scoreGenerationAttempt({
        compose: composeFacts({
          saved: false,
          staticOk: false,
          trial: { outcome: 'passed', full: true, coveredSteps: 9, totalSteps: 4 },
        }),
      }),
    ).toBe(0.15)
  })

  it('passes only on a clean, complete, verified replay', () => {
    expect(attemptPasses({ compose: composeFacts(), replay: replayFacts() })).toBe(true)
    expect(attemptPasses({ compose: composeFacts(), replay: replayFacts({ ran: false }) })).toBe(
      false,
    )
    expect(attemptPasses({ compose: composeFacts(), replay: replayFacts({ ok: false }) })).toBe(
      false,
    )
    expect(
      attemptPasses({ compose: composeFacts(), replay: replayFacts({ verified: false }) }),
    ).toBe(false)
    expect(attemptPasses({ compose: composeFacts() })).toBe(false)
    expect(
      attemptPasses({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'L2', certified: true, unmetCount: 0 } }),
      }),
    ).toBe(true)
    expect(
      attemptPasses({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'L2', certified: false, unmetCount: 2 } }),
      }),
    ).toBe(false)
  })

  it('treats an unjudged goal (NONE) as neither pass nor block', () => {
    expect(
      attemptPasses({
        compose: composeFacts(),
        replay: replayFacts({ goal: { level: 'NONE', certified: false, unmetCount: 0 } }),
      }),
    ).toBe(true)
  })
})

describe('generation attempt failure kinds', () => {
  it('maps structured codes, including trial suffixes and dataflow', () => {
    expect(failureKindOfCode('LOCATOR_NOT_FOUND')).toBe('locator-not-found')
    expect(failureKindOfCode('READINESS_TIMEOUT(visible)')).toBe('readiness')
    expect(failureKindOfCode('UNRESOLVED_INPUT')).toBe('dataflow')
    expect(failureKindOfCode('UNRESOLVED_INPUT(keyword)')).toBe('dataflow')
    expect(failureKindOfCode('NOT_A_CODE')).toBeUndefined()
    expect(failureKindOfCode('ABORTED')).toBeUndefined()
  })

  it('follows the documented priority', () => {
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({ staticErrorCount: 3 }),
        replay: replayFacts({
          ok: false,
          verified: false,
          failureCode: 'READINESS_TIMEOUT(visible)',
        }),
      }),
    ).toBe('readiness')
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({ goal: { level: 'L2', certified: false, unmetCount: 1 } }),
        replay: replayFacts({ ok: false, verified: false }),
      }),
    ).toBe('goal-verification')
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({ terminalStepMissing: true, staticErrorCount: 1 }),
        replay: replayFacts({ ok: false, verified: false }),
      }),
    ).toBe('intent')
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({ staticErrorCount: 2 }),
        replay: replayFacts({ ok: false, verified: false }),
      }),
    ).toBe('graph')
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({
          saved: false,
          trial: { outcome: 'partial', full: false, coveredSteps: 2, totalSteps: 6 },
        }),
      }),
    ).toBe('side-effect')
    expect(
      failureKindOfAttempt({
        pass: false,
        compose: composeFacts({
          saved: false,
          trial: { outcome: 'timeout', full: false, coveredSteps: 2, totalSteps: 6 },
        }),
      }),
    ).toBe('readiness')
    expect(failureKindOfAttempt({ pass: false, stage: 'harness' })).toBe('environment')
    expect(failureKindOfAttempt({ pass: false, stage: 'generate' })).toBe('intent')
    expect(failureKindOfAttempt({ pass: false, stage: 'goal' })).toBe('goal-verification')
    expect(failureKindOfAttempt({ pass: false })).toBe('unknown')
    expect(failureKindOfAttempt({ pass: true })).toBeUndefined()
  })
})

describe('merging generation attempts', () => {
  it('folds replay facts into the compose record and recomputes everything', () => {
    const previous: GenerationAttemptRecord = {
      at: 1,
      attemptId: 'attempt-1',
      origin: 'chat-generate',
      round: 42,
      model: { name: 'test-model', temperature: 0.2 },
      compose: composeFacts(),
      pass: false,
      score: 0.4,
    }
    const merged = mergeGenerationAttempt(previous, {
      attemptId: 'attempt-1',
      at: 2,
      replay: replayFacts({ goal: { level: 'L3', certified: true, unmetCount: 0 } }),
    })
    expect(merged).toEqual({
      at: 2,
      attemptId: 'attempt-1',
      origin: 'chat-generate',
      round: 42,
      model: { name: 'test-model', temperature: 0.2 },
      compose: composeFacts(),
      replay: replayFacts({ goal: { level: 'L3', certified: true, unmetCount: 0 } }),
      pass: true,
      score: 1,
    })
  })

  it('labels a failed replay and keeps repair facts on the replay block', () => {
    const merged = mergeGenerationAttempt(
      { at: 1, attemptId: 'attempt-1', compose: composeFacts(), pass: false, score: 0.25 },
      {
        attemptId: 'attempt-1',
        at: 2,
        replay: replayFacts({
          ok: false,
          verified: false,
          outcome: 'failed',
          failureCode: 'READINESS_TIMEOUT(visible)',
          coveredSteps: 4,
          totalSteps: 5,
          repair: { attempted: true, status: 'exhausted', attempts: 3, committed: false },
        }),
      },
    )
    expect(merged.pass).toBe(false)
    expect(merged.failureKind).toBe('readiness')
    expect(merged.replay?.repair).toEqual({
      attempted: true,
      status: 'exhausted',
      attempts: 3,
      committed: false,
    })
    expect(merged.score).toBe(0.37)
  })

  it('replaces blocks whole rather than merging their fields', () => {
    const merged = mergeGenerationAttempt(
      {
        at: 1,
        attemptId: 'attempt-1',
        compose: composeFacts({ saved: true, staticOk: true, nodeCount: 9 }),
        pass: false,
        score: 0.4,
      },
      {
        attemptId: 'attempt-1',
        at: 2,
        compose: composeFacts({ saved: true, staticOk: true, nodeCount: 3 }),
      },
    )
    expect(merged.compose?.nodeCount).toBe(3)
    expect(merged.score).toBe(0.4)
  })
})

describe('normalizing persisted attempts', () => {
  it('round-trips a complete record', () => {
    const record = attempt({
      round: 12,
      buildStampHash: 'abc123def456',
      model: { name: 'test-model', temperature: 0.2 },
      origin: 'chat-generate',
      stage: 'goal',
    })
    expect(normalizeGenerationAttempt(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('drops records missing identity, verdict or score', () => {
    expect(normalizeGenerationAttempt(undefined)).toBeUndefined()
    expect(normalizeGenerationAttempt([])).toBeUndefined()
    expect(normalizeGenerationAttempt({ at: 1, pass: true, score: 1 })).toBeUndefined()
    expect(normalizeGenerationAttempt({ attemptId: 'a', pass: true, score: 1 })).toBeUndefined()
    expect(normalizeGenerationAttempt({ attemptId: 'a', at: 1, score: 1 })).toBeUndefined()
    expect(normalizeGenerationAttempt({ attemptId: 'a', at: 1, pass: true })).toBeUndefined()
    expect(
      normalizeGenerationAttempt({ attemptId: 'a', at: 1, pass: true, score: Number.NaN }),
    ).toBeUndefined()
    expect(
      normalizeGenerationAttempt({ attemptId: '', at: 1, pass: true, score: 1 }),
    ).toBeUndefined()
  })

  it('drops malformed blocks and fields instead of the whole record', () => {
    const normalized = normalizeGenerationAttempt({
      attemptId: 'a',
      at: 1,
      pass: false,
      score: 0.2,
      compose: { saved: 'yes' },
      replay: replayFacts({ goal: { level: 'L9', certified: true, unmetCount: 0 } as never }),
      failureKind: 'not-a-kind',
    })
    expect(normalized).toBeDefined()
    expect(normalized?.compose).toBeUndefined()
    expect(normalized?.replay?.goal).toBeUndefined()
    expect(normalized?.replay?.verified).toBe(true)
    expect(normalized?.failureKind).toBeUndefined()
  })
})

describe('generation attempt summary', () => {
  const records: GenerationAttemptRecord[] = [
    attempt({
      attemptId: 'a',
      pass: true,
      score: 1,
      compose: composeFacts({ coverageGap: 2 }),
      replay: replayFacts({ goal: { level: 'L3', certified: true, unmetCount: 0 } }),
    }),
    attempt({
      attemptId: 'b',
      pass: false,
      score: 0.25,
      failureKind: 'readiness',
      replay: replayFacts({ ok: false, verified: false, proven: false, outcome: 'failed' }),
    }),
    attempt({
      attemptId: 'c',
      pass: false,
      score: 0.4,
      failureKind: 'goal-verification',
      replay: replayFacts({
        verified: false,
        proven: false,
        goal: { level: 'L2', certified: false, unmetCount: 1 },
      }),
    }),
    attempt({
      attemptId: 'd',
      pass: true,
      score: 0.6,
      replay: replayFacts({ proven: false }),
    }),
  ]

  it('counts passes, goals, proof, gaps and failure kinds', () => {
    const summary = summarizeGenerationAttempts(records)
    expect(summary.total).toBe(4)
    expect(summary.pass).toBe(2)
    expect(summary.passRate).toBe(0.5)
    expect(summary.l3Certified).toBe(1)
    expect(summary.verifiedAndProven).toBe(1)
    expect(summary.coverageGapRounds).toBe(1)
    expect(summary.meanScore).toBe(0.563)
    expect(summary.byGoalLevel).toEqual({ L1: 0, L2: 0, L3: 1, NONE: 0 })
    expect(summary.byFailureKind).toEqual([
      { kind: 'goal-verification', count: 1 },
      { kind: 'readiness', count: 1 },
    ])
    expect(summary.passInterval).toEqual(wilsonInterval(2, 4))
    expect(summary.l3Interval).toEqual(wilsonInterval(1, 4))
    expect(summary.meanScoreInterval).toEqual(bootstrapMeanInterval([1, 0.25, 0.4, 0.6]))
  })

  it('is empty-but-well-formed for no records', () => {
    expect(summarizeGenerationAttempts([])).toEqual({
      total: 0,
      pass: 0,
      passRate: 0,
      l3Certified: 0,
      verifiedAndProven: 0,
      coverageGapRounds: 0,
      meanScore: 0,
      passInterval: { low: 0, high: 1 },
      l3Interval: { low: 0, high: 1 },
      meanScoreInterval: { low: 0, high: 0 },
      byGoalLevel: { L1: 0, L2: 0, L3: 0, NONE: 0 },
      byFailureKind: [],
    })
  })
})

describe('interval helpers', () => {
  it('returns the full range for no observations', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
  })

  it('matches the Wilson values used in the design note', () => {
    expect(wilsonInterval(9, 82)).toEqual({ low: 0.0588, high: 0.1956 })
    expect(wilsonInterval(3, 82)).toEqual({ low: 0.0125, high: 0.1021 })
  })

  it('never leaves 0..1 and clamps impossible inputs', () => {
    expect(wilsonInterval(0, 10).low).toBe(0)
    expect(wilsonInterval(10, 10).high).toBe(1)
    expect(wilsonInterval(-5, 10)).toEqual(wilsonInterval(0, 10))
    expect(wilsonInterval(50, 10)).toEqual(wilsonInterval(10, 10))
  })

  it('is deterministic and brackets the observed mean', () => {
    const values = [1, 0.25, 0.4, 0.6]
    expect(bootstrapMeanInterval(values)).toEqual(bootstrapMeanInterval(values))
    const interval = bootstrapMeanInterval(values)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    expect(interval.low).toBeLessThanOrEqual(mean)
    expect(interval.high).toBeGreaterThanOrEqual(mean)
    expect(interval.high).toBeLessThanOrEqual(1)
    expect(interval.low).toBeGreaterThanOrEqual(0)
  })

  it('collapses to the value when every score is identical', () => {
    expect(bootstrapMeanInterval([0.5, 0.5, 0.5])).toEqual({ low: 0.5, high: 0.5 })
    expect(bootstrapMeanInterval([])).toEqual({ low: 0, high: 0 })
  })
})
