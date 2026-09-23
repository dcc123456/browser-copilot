import { describe, expect, it } from 'vitest'
import { toRepairResponse } from '../../src/lib/workflow/repair/repair-response'
import type {
  FailureAnalysis,
  VerificationResult,
  WorkflowPatchOperation,
} from '../../src/lib/workflow/repair/types'
import {
  discardRepairSession,
  getRepairSession,
  pendingRepairWorkflowIds,
  putRepairSession,
  takeRepairSession,
} from '../../src/background/workflow-engine/repair/repair-session-store'
import { edge, makeWorkflow, node } from './helpers'

function workflow() {
  return makeWorkflow(
    [
      node('t', 'trigger'),
      node('n3', 'get-text', { variableName: 'captcha' }),
      node('n5', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n3'), edge('n3', 'n5')],
  )
}

const analysis = (): FailureAnalysis => ({
  analysisVersion: 1,
  analysisId: 'a1',
  failedNodeId: 'n5',
  rootCauseNodeIds: ['n3'],
  failureType: 'VARIABLE_EMPTY',
  repairTarget: 'UPSTREAM_NODE',
  dependencyChain: [],
  variableEvidence: [
    {
      evidenceId: 'ev1',
      variable: 'captcha',
      nodeId: 'n3',
      kind: 'EMPTY',
      summary: { exists: true, isEmpty: true, type: 'string', length: 0, redacted: false },
      detail: 'captcha was produced but is empty',
    },
  ],
  pageEvidence: [],
  alternatives: [],
  explanation: 'producer is root',
  confidence: 0.85,
  retryRecommended: false,
})

const verification = (verified: boolean): VerificationResult => ({
  success: !verified,
  verified,
  trace: {
    traceId: 't1',
    workflowId: 'wf',
    runId: 'r1',
    entry: 'DEBUG',
    startedAt: 0,
    outcome: verified ? 'ok' : 'failed',
    events: [],
    nodeExecutions: [],
    checkpoints: [],
    finalVariables: {},
  },
  executedNodes: [],
  skippedNodes: [],
  warnings: [],
  usedAiTakeover: false,
  usedFallbackReplay: false,
})

describe('repair response projection', () => {
  it('projects analysis + verification into the wire shape without the trace', () => {
    const operations: WorkflowPatchOperation[] = [
      {
        operationId: 'op1',
        nodeId: 'n3',
        kind: 'SET_PARAM',
        path: 'selector',
        before: '.old',
        after: '.new',
        reason: 'read correct node',
        evidenceIds: ['ev1'],
      },
    ]
    const data = toRepairResponse('wf-1', analysis(), verification(true), 'AUTO_REPAIR', operations)
    expect(data.workflowId).toBe('wf-1')
    expect(data.mode).toBe('AUTO_REPAIR')
    expect(data.ok).toBe(true)
    expect(data.verified).toBe(true)
    expect(data.failedNodeId).toBe('n5')
    expect(data.rootCauseNodeIds).toEqual(['n3'])
    expect(data.variableRows).toEqual([
      {
        variable: 'captcha',
        producerNodeId: 'n3',
        status: 'empty',
      },
    ])
    expect(data.patchRows).toHaveLength(1)
    expect(data.patchRows[0]).toMatchObject({
      nodeId: 'n3',
      path: 'selector',
      before: '.old',
      after: '.new',
    })
    // No trace / workflow leakage.
    expect(JSON.stringify(data)).not.toContain('nodeExecutions')
  })

  it('carries the reason on a degraded proposal', () => {
    const data = toRepairResponse('wf', analysis(), verification(false), 'SUGGEST', [], {
      ok: false,
      reason: 'no patch proposed',
    })
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('no patch proposed')
  })
})

describe('repair session store', () => {
  it('holds a verified working copy until committed or discarded', () => {
    const wf = workflow()
    putRepairSession({
      workflowId: 'wf-store',
      workingCopy: wf,
      patch: {
        patchSetId: 'ps',
        analysisId: 'a1',
        operations: [],
        reason: '',
        confidence: 0.85,
        expectedEffect: '',
      },
      analysis: analysis(),
      verification: verification(true),
      baseUpdatedAt: 0,
      baseHash: 'base',
      createdAt: 1,
    })
    expect(pendingRepairWorkflowIds()).toContain('wf-store')
    expect(getRepairSession('wf-store')?.workingCopy).toBe(wf)

    // take removes the session for the commit.
    const taken = takeRepairSession('wf-store')
    expect(taken?.workingCopy).toBe(wf)
    expect(getRepairSession('wf-store')).toBeUndefined()
  })

  it('discard removes the session', () => {
    putRepairSession({
      workflowId: 'wf-discard',
      workingCopy: workflow(),
      patch: {
        patchSetId: 'p',
        analysisId: 'a',
        operations: [],
        reason: '',
        confidence: 0.8,
        expectedEffect: '',
      },
      analysis: analysis(),
      verification: verification(true),
      baseUpdatedAt: 0,
      baseHash: 'base',
      createdAt: 1,
    })
    expect(discardRepairSession('wf-discard')).toBe(true)
    expect(discardRepairSession('wf-discard')).toBe(false)
  })
})
