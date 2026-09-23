/**
 * Low-confidence confirmation gate tests (spec §6.5, §17.2 · P2).
 */
import { describe, expect, it } from 'vitest'

import { decideConfidence } from '../../src/lib/workflow/repair/confirmation-gate'
import { DEFAULT_REPAIR_POLICY } from '../../src/lib/workflow/repair/types'
import type { FailureAnalysis, WorkflowPatchSet } from '../../src/lib/workflow/repair/types'

const analysis = (confidence: number): FailureAnalysis => ({
  analysisVersion: 1,
  analysisId: 'a',
  failedNodeId: 'n5',
  rootCauseNodeIds: ['n3'],
  failureType: 'VARIABLE_EMPTY',
  repairTarget: 'UPSTREAM_NODE',
  dependencyChain: [],
  variableEvidence: [],
  pageEvidence: [],
  alternatives: [],
  explanation: '',
  confidence,
  retryRecommended: false,
})

const patch = (confidence: number): WorkflowPatchSet => ({
  patchSetId: 'ps',
  analysisId: 'a',
  operations: [],
  reason: '',
  confidence,
  expectedEffect: '',
})

describe('decideConfidence', () => {
  it('auto-applies at/above the threshold', () => {
    const decision = decideConfidence({
      analysis: analysis(0.95),
      patch: patch(0.9),
      policy: DEFAULT_REPAIR_POLICY,
    })
    expect(decision.autoApply).toBe(true)
    expect(decision.requiresConfirmation).toBe(false)
  })

  it('requires confirmation below the threshold', () => {
    const decision = decideConfidence({
      analysis: analysis(0.6),
      patch: patch(0.9),
      policy: DEFAULT_REPAIR_POLICY,
    })
    expect(decision.autoApply).toBe(false)
    expect(decision.requiresConfirmation).toBe(true)
    expect(decision.effectiveConfidence).toBe(0.6)
    expect(decision.reason).toContain('threshold')
  })

  it('uses the WEAKER of diagnosis and patch confidence', () => {
    const decision = decideConfidence({
      analysis: analysis(0.99),
      patch: patch(0.5),
      policy: DEFAULT_REPAIR_POLICY,
    })
    expect(decision.effectiveConfidence).toBe(0.5)
    expect(decision.requiresConfirmation).toBe(true)
  })

  it('judges the diagnosis alone without a patch', () => {
    const decision = decideConfidence({
      analysis: analysis(0.8),
      policy: DEFAULT_REPAIR_POLICY,
    })
    expect(decision.autoApply).toBe(true)
  })
})
