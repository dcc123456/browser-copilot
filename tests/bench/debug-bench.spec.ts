/**
 * Offline AI-debug benchmark (调试离线基准 · CI 回归门).
 *
 * Runs the scripted scenarios through the real debug-session loop and asserts
 * the invariants that define a trustworthy success rate:
 *  - a login wall burns exactly ONE takeover attempt (fast-fail works);
 *  - a missing provider burns ZERO attempts;
 *  - a takeover that completes without a verifiable fix is NOT a success;
 *  - "verified" always means a takeover-free pass with the goal achieved.
 *
 * The printed report is the baseline the success-rate work is measured against.
 * Everything is dependency-injected: no browser, no model, no network.
 */
import { describe, expect, it } from 'vitest'

import { formatReport, runBench, runScenario } from './harness'
import { BENCH_SCENARIOS } from './scenarios'

describe('AI-debug offline benchmark', () => {
  it('produces a report over every scenario', async () => {
    const report = await runBench()

    console.log(`\n${formatReport(report)}\n`)

    console.log(
      `[bench] JSON ${JSON.stringify({ successRate: report.successRate, total: report.total, verified: report.verified })}`,
    )
    expect(report.total).toBe(BENCH_SCENARIOS.length)
    expect(report.verified).toBeGreaterThan(0)
    expect(report.successRate).toBeGreaterThanOrEqual(0.6)
  })

  it('every verified outcome is a goal-achieving takeover-free pass', async () => {
    const report = await runBench()
    for (const outcome of report.outcomes) {
      if (!outcome.verified) continue
      expect(outcome.ok).toBe(true)
      expect(outcome.goalAchieved).toBe(true)
      expect(outcome.phases).toContain('takeover')
    }
  })

  it('fast-fails a login wall after exactly one attempt', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S3-environment')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.takeoverAttempts).toBe(1)
    expect(outcome.verified).toBe(false)
  })

  it('burns zero attempts when no provider is configured', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S8-no-provider')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.takeoverAttempts).toBe(0)
    expect(outcome.verified).toBe(false)
  })

  it('never counts a fixless takeover as verified', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S7-misjudge')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.verified).toBe(false)
    expect(outcome.ok).toBe(false)
  })

  it('escalates a structural bad graph to replay+audit and verifies the rewrite', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S5-structural')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.phases).toEqual(
      expect.arrayContaining(['takeover', 'replay', 'audit', 'rewrite-verify']),
    )
    expect(outcome.verified).toBe(true)
  })

  it('passes a resilient run on the first pass without takeover', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S6-resilience')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.verified).toBe(true)
    expect(outcome.phases).toEqual(['takeover'])
  })

  it('stops a non-idempotent login at the terminal state instead of retrying', async () => {
    // The reported bug: already logged in → the login page is gone → the old
    // loop retried (and replayed) forever.
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'S9-non-idempotent')
    expect(scenario).toBeDefined()
    const outcome = await runScenario(scenario!)
    expect(outcome.alreadySatisfied).toBe(true)
    expect(outcome.verified).toBe(true)
    // Never escalated: no replay, no audit, no extra rounds.
    expect(outcome.phases).toEqual(['takeover'])
    expect(outcome.rounds).toBe(1)
  })
})
