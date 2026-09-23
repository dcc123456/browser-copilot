/**
 * Reliability baseline (spec §3 Phase 0).
 *
 * Runs the ten reliability fixtures (R01–R10) through the PURE engine in compat
 * mode and asserts the recorded BASELINE outcome of each. This file is three
 * things at once:
 *
 *   1. the "know the current success rate before changing anything" record the
 *      spec demands — every dangerous behavior documented as a deterministic
 *      assertion;
 *   2. the regression guard for the whole reliability project: compat-mode
 *      behavior (hand-made / imported workflows) must stay EXACTLY this through
 *      every phase — any phase that flips one of these assertions has broken
 *      compatibility and must stop;
 *   3. the anchor the Phase 11 benchmark measures against: the same scenarios
 *      run in generated-strict mode must reach their TARGET outcomes instead.
 *
 * The fixtures live in `specs/reliability-fixtures/` next to the spec document.
 */
import { describe, expect, it } from 'vitest'
import { RELIABILITY_SCENARIOS, runScenario, type ExpectedOutcome } from '../specs/reliability-fixtures/scenarios'
import type { FixturePass } from '../specs/reliability-fixtures/harness'

/** Assert one scenario's observed pass sequence against its expected outcome. */
function expectOutcome(
  observed: { passes: FixturePass[]; final: FixturePass; submitCalls: number },
  expected: ExpectedOutcome,
): void {
  const final = observed.final
  expect(final.outcome, `${'run outcome'}`).toBe(expected.outcome)
  if (expected.errorContains) {
    for (const needle of expected.errorContains) {
      expect(final.error ?? '', `error should mention "${needle}"`).toContain(needle)
    }
  }
  if (expected.submitCalls !== undefined) {
    expect(observed.submitCalls, 'cumulative submit calls').toBe(expected.submitCalls)
  }
  if (expected.firstOfManyClicked !== undefined) {
    const anyFirstOfMany = observed.passes.some((pass) =>
      pass.actions.some((action) => action.firstOfMany === true),
    )
    expect(anyFirstOfMany, 'some click acted on the first of many matches').toBe(
      expected.firstOfManyClicked,
    )
  }
  if (expected.variables) {
    for (const [name, value] of Object.entries(expected.variables)) {
      expect(final.variables[name]).toEqual(value)
    }
  }
  if (expected.actionsInclude) {
    for (const needle of expected.actionsInclude) {
      const hit = observed.passes.some((pass) =>
        pass.actions.some(
          (action) =>
            action.action.includes(needle) ||
            (action.selector ?? '').includes(needle) ||
            (action.usedSpec ?? '').includes(needle),
        ),
      )
      expect(hit, `action ledger should include "${needle}"`).toBe(true)
    }
  }
}

describe('workflow reliability baseline (R01–R10, compat mode)', () => {
  for (const scenario of RELIABILITY_SCENARIOS) {
    it(`${scenario.id} ${scenario.title}: records the compat baseline`, async () => {
      const observed = await runScenario(scenario, 'compat')
      expectOutcome(observed, scenario.baseline)
    })
  }
})

describe('reliability fixture integrity', () => {
  it('covers exactly the ten spec scenarios with both outcomes declared', () => {
    expect(RELIABILITY_SCENARIOS.map((s) => s.id)).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
    ])
    for (const scenario of RELIABILITY_SCENARIOS) {
      expect(scenario.baseline.outcome).toBeDefined()
      expect(scenario.target.outcome).toBeDefined()
      expect(scenario.description.trim()).not.toBe('')
    }
  })

  it('runs every scenario in strict mode deterministically too (outcome snapshot)', async () => {
    // Phase 11: strict mode now CONSUMES the reliability contract (strict
    // resolver, readiness polling, empty-variable guard, terminal-state skip),
    // so this snapshot asserts the TARGET outcomes — the dangerous compat
    // baselines become safe. Compat equivalence remains pinned by the tests
    // above; the layered-metrics benchmark lives in
    // tests/reliability-benchmark.spec.ts.
    for (const scenario of RELIABILITY_SCENARIOS) {
      const observed = await runScenario(scenario, 'strict')
      expectOutcome(observed, scenario.target)
    }
  })
})
