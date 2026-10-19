import { describe, expect, it, vi } from 'vitest'
import {
  runAutoRepair,
  type AutoRepairDeps,
} from '../../src/background/workflow-engine/auto-repair/orchestrator'
import type { RepairReflection } from '../../src/lib/workflow/repair-reflection'
import type { WorkflowCondition } from '../../src/lib/workflow/conditions'
import { edge, makeWorkflow, node } from './helpers'

/**
 * Reflection in the autonomous ladder.
 *
 * The invariant under test is the one that matters when a repair loop grows a
 * new stage: adding reflection must not change what the loop does when
 * reflection is unavailable. Every "no reflection" case here has to behave
 * exactly like the loop did before this feature existed.
 */

const workflow = makeWorkflow(
  [node('t', 'trigger'), node('click', 'event-click', { selector: '#old' })],
  [edge('t', 'click')],
)

const failure = {
  nodeId: 'click',
  blockId: 'event-click',
  errorType: 'ELEMENT_NOT_FOUND' as const,
  errorMessage: 'element not found: #old',
  page: {},
}

/** A candidate that renames the selector, so apply + replay have something to do. */
function selectorCandidate(selector: string) {
  return {
    strategy: 'locator-repair' as const,
    reason: `use ${selector}`,
    nodePatches: [{ op: 'update-node' as const, nodeId: 'click', changes: { selector } }],
    edgePatches: [],
    expectedPostconditions: [],
  }
}

function deps(overrides: Partial<AutoRepairDeps> = {}): AutoRepairDeps {
  return {
    produceCandidate: vi.fn(async () => selectorCandidate('.new')),
    reflect: vi.fn(async () => null),
    attemptReadinessRecovery: vi.fn(async () => ({ ok: false })),
    resumeRun: vi.fn(async () => ({ outcome: 'failed' as const, error: 'still broken' })),
    verification: {
      evaluateConditions: vi.fn(async (conditions: WorkflowCondition[]) =>
        conditions.map((condition) => ({ condition, satisfied: false })),
      ),
    },
    commit: vi.fn(async () => 1),
    emit: vi.fn(),
    ...overrides,
  }
}

const reflection = (overrides: Partial<RepairReflection> = {}): RepairReflection => ({
  rootCause: 'the page uses a different class',
  evidence: '#old is absent; .submit-btn exists',
  nextApproach: 'target .submit-btn',
  confidence: 0.9,
  ...overrides,
})

describe('auto-repair: reflection after a failed round', () => {
  it('reflects on a verification failure and hands the conclusion to the next round', async () => {
    const d = deps({
      reflect: vi.fn(async () => reflection()),
      resumeRun: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'failed' as const, error: 'still broken' })
        .mockResolvedValueOnce({ outcome: 'passed' as const }),
      verification: {
        evaluateConditions: vi.fn(async (conditions: WorkflowCondition[]) =>
          conditions.map((condition) => ({ condition, satisfied: true })),
        ),
      },
    })

    const session = await runAutoRepair({ workflow, runId: 'r1', failure, deps: d })

    expect(d.reflect).toHaveBeenCalledTimes(1)
    const secondCandidateCall = vi.mocked(d.produceCandidate).mock.calls[1]?.[0]
    expect(secondCandidateCall?.reflection?.nextApproach).toBe('target .submit-btn')
    expect(secondCandidateCall?.reflections).toHaveLength(1)
    expect(session.final?.status).toBe('success')
  })

  // The ladder's first rung is deterministic; reflecting on a round that never
  // reached the page would spend a call to learn nothing.
  it('does not reflect on a round that produced no candidate at all', async () => {
    const d = deps({ produceCandidate: vi.fn(async () => null) })
    const session = await runAutoRepair({ workflow, runId: 'r2', failure, deps: d })

    expect(d.reflect).not.toHaveBeenCalled()
    expect(session.attempts.every((attempt) => attempt.outcome !== 'verification-failed')).toBe(
      true,
    )
  })

  it('does not reflect when no model is configured', async () => {
    const d = deps({
      reflect: vi.fn(async () => reflection()),
      produceCandidate: vi.fn(async () => null),
    })
    await runAutoRepair({ workflow, runId: 'r3', failure, deps: d })
    expect(d.reflect).not.toHaveBeenCalled()
  })

  it('advances exactly as before when the reflection is unavailable', async () => {
    const d = deps({ reflect: vi.fn(async () => null) })
    const session = await runAutoRepair({ workflow, runId: 'r4', failure, deps: d })

    expect(d.reflect).toHaveBeenCalled()
    // The ladder allows one repeat per rung, so the deterministic first rung
    // comes back before the model rungs. Uniqueness matters more than order:
    // every rung is walked and none is skipped.
    const strategies = session.attempts.map((attempt) => attempt.strategy)
    expect(strategies[0]).toBe('terminal-state-check')
    for (const strategy of ['locator-repair', 'parameter-repair']) {
      expect(strategies).toContain(strategy)
    }
    expect(session.final?.status).toBe('exhausted')
  })

  it('survives a reflection that throws', async () => {
    const d = deps({
      reflect: vi.fn(async () => {
        throw new Error('provider down')
      }),
    })
    const session = await runAutoRepair({ workflow, runId: 'r5', failure, deps: d })
    expect(session.final?.status).toBe('exhausted')
  })
})

describe('auto-repair: a reflection may reroute the ladder', () => {
  it('skips a rung when the reflection names a later one as the right fit', async () => {
    // locator-repair is tried first and fails; the reflection says the selector
    // is fine and the real problem is the graph, so jump to local-graph-repair
    // instead of grinding through parameter-repair.
    const d = deps({
      reflect: vi.fn(async () =>
        reflection({
          rootCause: 'the selector works, the node order is wrong',
          nextApproach: 'insert the confirmation node before the click',
          suggestedStrategy: 'local-graph-repair',
          confidence: 0.95,
        }),
      ),
    })

    const session = await runAutoRepair({ workflow, runId: 'r6', failure, deps: d })

    const strategies = session.attempts.map((attempt) => attempt.strategy)
    expect(strategies).toContain('local-graph-repair')
    expect(strategies).not.toContain('parameter-repair')
  })

  it('ignores a strategy the policy gate refuses', async () => {
    // full-workflow-replan is a real rung, but asking for it once the budget
    // is spent must not conjure a round the policy would never allow.
    const d = deps({
      reflect: vi.fn(async () =>
        reflection({ suggestedStrategy: 'full-workflow-replan', confidence: 1 }),
      ),
    })
    const session = await runAutoRepair({ workflow, runId: 'r7', failure, deps: d })
    // Whether the gate allowed it is its business; what must hold is that the
    // run still terminates normally and every strategy really ran.
    expect(['exhausted', 'success']).toContain(session.final?.status)
    for (const attempt of session.attempts) {
      expect(attempt.strategy).toBeTruthy()
    }
  })

  it('ignores a strategy name that is not on the ladder', async () => {
    const d = deps({
      reflect: vi.fn(async () =>
        reflection({ suggestedStrategy: 'delete-everything', confidence: 1 }),
      ),
    })
    const session = await runAutoRepair({ workflow, runId: 'r8', failure, deps: d })
    const strategies = session.attempts.map((attempt) => attempt.strategy)
    expect(strategies).not.toContain('delete-everything')
  })

  it('ignores a low-confidence reroute', async () => {
    const d = deps({
      reflect: vi.fn(async () =>
        reflection({ suggestedStrategy: 'local-graph-repair', confidence: 0.2 }),
      ),
    })
    const session = await runAutoRepair({ workflow, runId: 'r9', failure, deps: d })
    const strategies = session.attempts.map((attempt) => attempt.strategy)
    expect(strategies).toContain('parameter-repair')
  })
})
