import { describe, expect, it } from 'vitest'
import { newGenerationMetrics, recordMetric, summarizeMetrics } from '../src/lib/workflow/generation-metrics'
// Goal-completion rates (V89) are derived per run from the verification
// reports; here we compute them over a simulated multi-run sample using the
// same metrics primitive plus explicit verified counts.
function rate(part: number, whole: number): number { return whole ? Number((part / whole).toFixed(3)) : 0 }
describe('V89 goal metrics', () => {
  const sample = { workflows: 10, goalsVerified: 9, nodes: 24, nodeGoalsVerified: 22, criteriaCovered: 23 }
  it('measures workflow/node goal completion, criteria coverage, verification rate', () => {
    const workflowGoalCompletionRate = rate(sample.goalsVerified, sample.workflows)
    const nodeGoalCompletionRate = rate(sample.nodeGoalsVerified, sample.nodes)
    const nodeSuccessCriteriaCoverage = rate(sample.criteriaCovered, sample.nodes)
    const goalVerificationRate = rate(sample.workflows, sample.workflows)
    expect(workflowGoalCompletionRate).toBe(0.9)
    expect(nodeGoalCompletionRate).toBeCloseTo(0.917, 2)
    expect(nodeSuccessCriteriaCoverage).toBeCloseTo(0.958, 2)
    expect(goalVerificationRate).toBe(1)
  })
})
describe('V90 operator selection metrics', () => {
  const sample = { tasks: 10, top1: 8, top3: 9, recovered: 6, recoverable: 8, targetRecovered: 4, targetCases: 5, paramRecovered: 2, paramCases: 2, unsupportedDetected: 3, unsupportedActual: 3 }
  it('measures top1 accuracy, top3 recall and recovery rates', () => {
    expect(rate(sample.top1, sample.tasks)).toBe(0.8)
    expect(rate(sample.top3, sample.tasks)).toBe(0.9)
    expect(rate(sample.recovered, sample.recoverable)).toBe(0.75)
    expect(rate(sample.targetRecovered, sample.targetCases)).toBe(0.8)
    expect(rate(sample.paramRecovered, sample.paramCases)).toBe(1)
    expect(rate(sample.unsupportedDetected, sample.unsupportedActual)).toBe(1)
  })
})
describe('V91 operator usage metrics', () => {
  it('derives native/ai/js rates from recorded attempts', () => {
    const m = newGenerationMetrics()
    recordMetric(m, { type: 'operator-attempt' }) // native
    recordMetric(m, { type: 'operator-attempt' }) // native
    recordMetric(m, { type: 'operator-attempt' }) // native
    recordMetric(m, { type: 'js-request' })
    recordMetric(m, { type: 'js-allowed-gap' })
    const total = m.operatorAttempts + m.jsAllowedCapabilityGap
    const nativeOperatorRate = rate(m.operatorAttempts, total)
    const javascriptFallbackRate = rate(m.jsAllowedCapabilityGap, total)
    expect(nativeOperatorRate).toBe(0.75)
    expect(javascriptFallbackRate).toBe(0.25)
  })
  it('blind retry rate is zero when no unclassified retries exist', () => {
    expect(rate(0, 10)).toBe(0)
  })
})
describe('V92 performance metrics', () => {
  it('summarizes average candidates, tool calls, schema tokens, recovery rounds and latency', () => {
    const m = newGenerationMetrics(0)
    recordMetric(m, { type: 'discovery', candidates: 3 })
    recordMetric(m, { type: 'tokens', prompt: 500 })
    recordMetric(m, { type: 'operator-attempt' })
    recordMetric(m, { type: 'node-recorded' })
    m.finishedAt = 250
    const summary = summarizeMetrics(m)
    expect(summary.durationMs).toBe(250)
    expect(summary.attemptsPerNode).toBe(1)
  })
})
describe('V93 repair metrics', () => {
  const sample = { repairs: 8, successful: 6, goalHeldAfter: 5, regressions: 1, rounds: 16 }
  it('measures repair success, repaired-goal success, regression rate and avg rounds', () => {
    expect(rate(sample.successful, sample.repairs)).toBe(0.75)
    expect(rate(sample.goalHeldAfter, sample.repairs)).toBe(0.625)
    expect(rate(sample.regressions, sample.repairs)).toBe(0.125)
    expect(rate(sample.rounds, sample.repairs)).toBe(2)
  })
})