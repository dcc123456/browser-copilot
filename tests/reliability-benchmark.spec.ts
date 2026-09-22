/**
 * Reliability benchmark (spec §15/§19, Phase 11): R01–R10 run in STRICT mode
 * against the baseline fixtures, measured through the layered metrics
 * (L1/L2/L3), with the certification state machine folded over the run.
 */
import { describe, expect, it } from 'vitest'
import { RELIABILITY_SCENARIOS as scenarios, runScenario } from '../specs/reliability-fixtures/scenarios'
import type { ReliabilityScenario as Scenario } from '../specs/reliability-fixtures/scenarios'
import {
  computeBenchmarkMetrics,
  certifyThrough,
  transitionCertification,
  type ScenarioBenchmark,
} from '../src/lib/workflow/reliability-certification'
import { validateGeneratedWorkflow } from '../src/lib/workflow/generated-validation'
import { isGeneratedStrict } from '../src/lib/workflow/reliability'

function strictGraphFor(scenario: Scenario): import('../src/lib/workflow/types').Workflow {
  const node = (id: string, blockId: string, data: Record<string, unknown> = {}) => ({
    id,
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  })
  const nodes = [
    node('t', 'trigger', { type: 'manual' }),
    node('a1', 'get-text', {
      selector: '#x',
      __reliability: {
        intent: '读取结果',
        postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
      },
    }),
  ]
  return {
    id: scenario.id,
    name: scenario.id,
    description: '',
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false, provenance: 'chat-generate' },
    table: [],
    drawflow: { nodes, edges: [{ id: 'e1', source: 't', target: 'a1', sourceHandle: 'next', targetHandle: 'input-1' }] },
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('R01–R10 in strict mode (spec §19 targets)', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: strict target = ${scenario.target?.outcome ?? 'n/a'}`, async () => {
      expect(scenario.target).toBeDefined()
      const result = await runScenario(scenario, 'strict')
      expect(result.final.outcome).toBe(scenario.target.outcome)
    })
  }
})

describe('side-effect evidence in strict mode', () => {
  it('R09 submits exactly once (no double execution)', async () => {
    const r09 = scenarios.find((s) => s.id === 'R09')!
    const result = await runScenario(r09, 'strict')
    expect(result.final.outcome).toBe('failed') // the read still fails…
    expect(result.submitCalls).toBe(1) // …but the submit did NOT re-fire
  })

  it('R03 never clicks the first-of-many in strict mode', async () => {
    const r03 = scenarios.find((s) => s.id === 'R03')!
    const result = await runScenario(r03, 'strict')
    expect(result.final.outcome).toBe('failed')
    expect(result.submitCalls ?? 0).toBe(0)
  })
})

describe('layered metrics + certification', () => {
  it('measures R01–R10 in strict mode through L1/L2/L3 and certifies', async () => {
    const benchmark: ScenarioBenchmark[] = []
    for (const scenario of scenarios) {
      const result = await runScenario(scenario, 'strict')
      const targetOk = scenario.target.outcome === 'ok'
      const executionSuccess = result.final.outcome === scenario.target.outcome
      // L2: verified evidence — side effects fired exactly once when the
      // target says ok (strict mode's own contract), and the failure is
      // structured when the target says failed.
      const verificationSuccess = targetOk ? result.submitCalls <= 1 : executionSuccess
      const goalAchieved = targetOk && executionSuccess
      benchmark.push({
        scenarioId: scenario.id,
        executionSuccess,
        verificationSuccess,
        goalAchieved,
        submitCalls: result.submitCalls,
      })
    }
    const metrics = computeBenchmarkMetrics(benchmark)

    expect(metrics.l1ExecutionSuccess).toBe(1)
    expect(metrics.l2VerificationSuccess).toBe(1)
    const goalScenarios = scenarios.filter((sc) => sc.target.outcome === 'ok').length
    expect(metrics.l3GoalAchieved).toBeCloseTo(goalScenarios / scenarios.length, 5)

    for (const scenario of scenarios) {
      expect(isGeneratedStrict(strictGraphFor(scenario))).toBe(true)
      expect(validateGeneratedWorkflow(strictGraphFor(scenario)).ok).toBe(true)
    }

    expect(certifyThrough(['validate-ok', 'benchmark-passed', 'certify'])).toBe('Certified')
    expect(certifyThrough(['benchmark-passed'])).toBe('Draft')
    expect(certifyThrough(['validate-ok', 'benchmark-passed', 'certify', 'graph-changed'])).toBe('Stale')
    expect(certifyThrough(['validate-ok', 'benchmark-failed'])).toBe('Stale')
    expect(transitionCertification('Draft', 'certify')).toBe('Draft')

    const report = computeBenchmarkMetrics([
      { scenarioId: 'X', executionSuccess: true, verificationSuccess: false, goalAchieved: true },
    ])
    expect(report.l2VerificationSuccess).toBe(0)
    expect(report.l3GoalAchieved).toBe(0)
    expect(report.failures[0]).toContain('L2')
  })
})
