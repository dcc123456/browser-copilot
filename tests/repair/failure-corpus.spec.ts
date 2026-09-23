/**
 * Offline failure-sample regression suite (spec §15 Phase 8, §16.1 · P2).
 *
 * Runs every labeled case in the failure corpus through the deterministic
 * analyzer and asserts the expected failed node, root-cause nodes, repair
 * target and failure type. No browser / provider — a pure offline guard that a
 * symptom is not mistaken for a root cause.
 */
import { describe, expect, it } from 'vitest'

import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { buildFailureCorpus } from '../../src/lib/workflow/repair/failure-corpus'

describe('offline failure corpus regression', () => {
  const corpus = buildFailureCorpus()

  it('contains the canonical labeled cases', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(5)
    const ids = corpus.map((sample) => sample.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const sample of corpus) {
    it(`${sample.id}: ${sample.description}`, () => {
      const analysis = analyzeFailure({
        workflow: sample.workflow,
        trace: sample.trace,
      })
      expect(analysis.failedNodeId).toBe(sample.expected.failedNodeId)
      expect([...analysis.rootCauseNodeIds].sort()).toEqual(
        [...sample.expected.rootCauseNodeIds].sort(),
      )
      expect(analysis.repairTarget).toBe(sample.expected.repairTarget)
      expect(analysis.failureType).toBe(sample.expected.failureType)
    })
  }

  it('is deterministic: same workflow + trace yields the same analysis', () => {
    const sample = corpus[0]!
    const first = analyzeFailure({ workflow: sample.workflow, trace: sample.trace })
    const second = analyzeFailure({ workflow: sample.workflow, trace: sample.trace })
    expect(second.rootCauseNodeIds).toEqual(first.rootCauseNodeIds)
    expect(second.dependencyChain).toEqual(first.dependencyChain)
    expect(second.repairTarget).toBe(first.repairTarget)
  })
})
