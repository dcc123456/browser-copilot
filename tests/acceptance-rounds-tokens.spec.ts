import { describe, expect, it } from 'vitest'
import { newGenerationMetrics, recordMetric, summarizeMetrics } from '../src/lib/workflow/generation-metrics'
describe('V71 tool round accounting', () => {
  it('records llm turns, operator calls and discovery calls for a simple task', () => {
    const m = newGenerationMetrics(1000)
    recordMetric(m, { type: 'discovery', candidates: 3 })
    recordMetric(m, { type: 'operator-attempt' })
    recordMetric(m, { type: 'node-recorded' })
    recordMetric(m, { type: 'operator-attempt' })
    recordMetric(m, { type: 'node-recorded' })
    recordMetric(m, { type: 'finish' })
    expect(m.discoveryCalls).toBe(1)
    expect(m.operatorAttempts).toBe(2)
    expect(m.nodesRecorded).toBe(2)
    // A simple task must not spiral into many discovery/recovery rounds.
    expect(m.recoveryTransitions).toBe(0)
  })
})
describe('V72 token accounting', () => {
  it('tracks prompt/completion tokens and keeps the simple-task summary tight', () => {
    const m = newGenerationMetrics(1000)
    recordMetric(m, { type: 'discovery', candidates: 3 })
    recordMetric(m, { type: 'tokens', prompt: 1200, completion: 300 })
    recordMetric(m, { type: 'operator-attempt' })
    recordMetric(m, { type: 'node-recorded' })
    recordMetric(m, { type: 'finish' })
    expect(m.promptTokens + m.completionTokens).toBe(1500)
    const summary = summarizeMetrics(m)
    expect(summary.attemptsPerNode).toBe(1)
    expect(summary.failureRate).toBe(0)
  })
  it('flags JS calls that did not go through the capability gap', () => {
    const m = newGenerationMetrics()
    recordMetric(m, { type: 'js-request' })
    recordMetric(m, { type: 'operator-attempt' })
    recordMetric(m, { type: 'node-recorded' })
    recordMetric(m, { type: 'finish' })
    expect(summarizeMetrics(m).jsOnlyViaGap).toBe(false)
  })
})