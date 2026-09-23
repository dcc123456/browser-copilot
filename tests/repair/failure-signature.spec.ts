/**
 * Node + root-cause aware failure signature tests (spec §13).
 */
import { describe, expect, it } from 'vitest'

import {
  buildFailureSignature,
  createRepeatCounter,
  reachedFailureThreshold,
  relevantVariablesOf,
  signatureFromAnalysis,
} from '../../src/lib/workflow/repair/failure-signature'
import type { FailureAnalysis } from '../../src/lib/workflow/repair/types'

const base = {
  workflowId: 'wf-1',
  failureType: 'VARIABLE_EMPTY' as const,
  error: '  Value  is  EMPTY\n ',
}

describe('buildFailureSignature', () => {
  it('includes every required field in a fixed order', () => {
    const signature = buildFailureSignature({
      ...base,
      nodeId: 'n5',
      rootCauseNodeIds: ['n3'],
      relevantVariableNames: ['captcha'],
    })
    expect(signature).toBe(
      'workflowId=wf-1|nodeId=n5|failureType=VARIABLE_EMPTY|' +
        'error=value is empty|rootCauses=n3|variables=captcha',
    )
  })

  it('normalizes and sorts lists deterministically', () => {
    const signature = buildFailureSignature({
      ...base,
      nodeId: 'n5',
      // Out-of-order, with duplicates.
      rootCauseNodeIds: ['n4', 'n3', 'n3'],
      relevantVariableNames: ['password', 'username', 'username'],
    })
    expect(signature).toContain('rootCauses=n3,n4')
    expect(signature).toContain('variables=password,username')
  })

  it('distinguishes identical errors at different nodes', () => {
    const atN5 = buildFailureSignature({ ...base, nodeId: 'n5' })
    const atN8 = buildFailureSignature({ ...base, nodeId: 'n8' })
    expect(atN5).not.toBe(atN8)
  })

  it('distinguishes the same node+error when the root cause moves', () => {
    const before = buildFailureSignature({
      ...base,
      nodeId: 'n5',
      rootCauseNodeIds: ['n3'],
    })
    const after = buildFailureSignature({
      ...base,
      nodeId: 'n5',
      rootCauseNodeIds: ['n6'],
    })
    expect(before).not.toBe(after)
  })

  it('falls back to unknown only when no node is given', () => {
    expect(buildFailureSignature(base)).toContain('nodeId=unknown')
  })
})

describe('signature repeat threshold', () => {
  it('uses the policy threshold rather than a hardcoded count', () => {
    // threshold 2: the SECOND occurrence is a dead end.
    expect(reachedFailureThreshold(0, 2)).toBe(false)
    expect(reachedFailureThreshold(1, 2)).toBe(true)
    // threshold 3.
    expect(reachedFailureThreshold(1, 3)).toBe(false)
    expect(reachedFailureThreshold(2, 3)).toBe(true)
  })

  it('counts and records occurrences', () => {
    const counter = createRepeatCounter()
    const signature = 'sig'
    expect(counter.count(signature)).toBe(0)
    counter.record(signature)
    counter.record(signature)
    expect(counter.count(signature)).toBe(2)
    expect(counter.count('other')).toBe(0)
  })
})

describe('signatureFromAnalysis', () => {
  const analysis: FailureAnalysis = {
    analysisVersion: 1,
    analysisId: 'a-1',
    failedNodeId: 'n5',
    rootCauseNodeIds: ['n3'],
    failureType: 'VARIABLE_EMPTY',
    repairTarget: 'UPSTREAM_NODE',
    dependencyChain: [
      { nodeId: 'n5', variable: 'captcha', relation: 'USES_VARIABLE' },
    ],
    variableEvidence: [
      {
        evidenceId: 'ev-1',
        variable: 'captcha',
        nodeId: 'n3',
        kind: 'EMPTY',
        summary: { exists: true, isEmpty: true, redacted: false },
        detail: '',
      },
    ],
    pageEvidence: [],
    alternatives: [],
    explanation: '',
    confidence: 0.85,
    retryRecommended: false,
  }

  it('derives relevant variables from evidence + dependency chain', () => {
    expect(relevantVariablesOf(analysis)).toEqual(['captcha'])
  })

  it('builds a stable signature bound to the analysis', () => {
    const signature = signatureFromAnalysis('wf-1', analysis, 'captcha is empty')
    expect(signature).toBe(
      'workflowId=wf-1|nodeId=n5|failureType=VARIABLE_EMPTY|' +
        'error=captcha is empty|rootCauses=n3|variables=captcha',
    )
  })
})
