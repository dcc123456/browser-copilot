/**
 * Production-telemetry repair-policy tuner tests (spec §15 Phase 8 · P3).
 */
import { describe, expect, it } from 'vitest'

import { MIN_SAMPLE_SIZE, tuneRepairPolicy } from '../../src/lib/workflow/repair/policy-tuner'
import { DEFAULT_REPAIR_POLICY } from '../../src/lib/workflow/repair/types'
import type { RepairPolicy } from '../../src/lib/workflow/repair/types'
import type { RepairRoundLog } from '../../src/lib/workflow/repair-metrics'

const log = (over: Partial<RepairRoundLog>): RepairRoundLog => ({
  at: 0,
  sessionId: 's',
  round: 1,
  entry: 'DEBUG',
  rootCauseNodeIds: [],
  transientRetries: 0,
  patchedNodeIds: [],
  usedCheckpoint: false,
  usedAiTakeover: false,
  result: 'VERIFIED',
  durationMs: 10,
  ...over,
})

describe('tuneRepairPolicy', () => {
  it('returns the default policy below the sample-size floor', () => {
    const result = tuneRepairPolicy(Array.from({ length: MIN_SAMPLE_SIZE - 1 }, () => log({})))
    expect(result.tuned).toBe(false)
    expect(result.policy).toBe(DEFAULT_REPAIR_POLICY)
  })

  it('sets maxRepairRounds from the convergence distribution', () => {
    // Most verify at round 1, a tail at round 6 ⇒ p90 around 6 + headroom.
    const logs = [
      ...Array.from({ length: 16 }, () => log({ round: 1 })),
      ...Array.from({ length: 4 }, () => log({ round: 6 })),
    ]
    const result = tuneRepairPolicy(logs)
    expect(result.policy.maxRepairRounds).toBeGreaterThanOrEqual(6)
    expect(result.adjustments.join(' ')).toContain('maxRepairRounds')
  })

  it('raises the confidence threshold (never lowers) when failures dominate', () => {
    const logs = [
      ...Array.from({ length: 10 }, () => log({ result: 'VERIFIED' })),
      ...Array.from({ length: 10 }, () => log({ result: 'FAILED', round: 2 })),
    ]
    const result = tuneRepairPolicy(logs)
    expect(result.policy.autoApplyConfidenceThreshold).toBeGreaterThanOrEqual(
      DEFAULT_REPAIR_POLICY.autoApplyConfidenceThreshold,
    )
  })

  it('never exceeds the safety bounds', () => {
    // Extreme: everything fails at high rounds with many retries.
    const logs = Array.from({ length: MIN_SAMPLE_SIZE }, () =>
      log({ result: 'FAILED', round: 9, transientRetries: 9 }),
    )
    const { policy } = tuneRepairPolicy(logs)
    expect(policy.maxRepairRounds).toBeLessThanOrEqual(8)
    expect(policy.maxTransientRetries).toBeLessThanOrEqual(4)
    expect(policy.autoApplyConfidenceThreshold).toBeLessThanOrEqual(0.95)
  })

  it('keeps maxSameFailureSignature tight without same-signature convergence', () => {
    const base: RepairPolicy = { ...DEFAULT_REPAIR_POLICY, maxSameFailureSignature: 3 }
    const logs = Array.from({ length: MIN_SAMPLE_SIZE }, () => log({ round: 1 }))
    const result = tuneRepairPolicy(logs, base)
    expect(result.policy.maxSameFailureSignature).toBe(1)
  })
})
