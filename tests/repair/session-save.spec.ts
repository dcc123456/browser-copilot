import { describe, expect, it } from 'vitest'
import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { sameAnalysis } from '../../src/background/workflow-engine/repair/root-cause-analyzer'
import { PatchEngine } from '../../src/lib/workflow/repair/patch-engine'
import type { FailureAnalysis, WorkflowPatchSet } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, makeWorkflow, node } from './helpers'

function upstreamWorkflow() {
  return makeWorkflow(
    [
      node('t', 'trigger'),
      node('n3', 'get-text', { variableName: 'captcha' }),
      node('n5', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n3'), edge('n3', 'n5')],
  )
}

describe('Session / save semantics (Test P–T)', () => {
  it('Test P: a failed debug repair keeps the analysis; no patch is committed', () => {
    const workflow = upstreamWorkflow()
    const trace = buildTrace(
      workflow,
      'run',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
      ],
      {},
    )
    const analysis: FailureAnalysis = analyzeFailure({ workflow, trace })
    // An unauthorized patch (targeting the symptom node's non-reference param)
    // must not exist — allowed paths on n5 only cover the bound reference.
    const patch: WorkflowPatchSet = {
      patchSetId: 'ps',
      analysisId: analysis.analysisId,
      operations: [
        {
          operationId: 'op',
          nodeId: 'n5',
          kind: 'SET_PARAM',
          path: 'label',
          after: 'changed',
          reason: 'r',
          evidenceIds: [],
        },
      ],
      reason: 'r',
      confidence: 0.5,
      expectedEffect: 'e',
    }
    const result = new PatchEngine().validatePatch(workflow, analysis, patch)
    expect(result.ok).toBe(false)
    // The formal workflow is untouched (we never produced a new Workflow).
    expect(workflow.drawflow.nodes[2]!.data['label']).toBeUndefined()
    // The analysis is retained for further debugging.
    expect(analysis.rootCauseNodeIds).toEqual(['n3'])
  })

  it('Test Q: budget exhausted on a non-structural failure preserves the analysis history', () => {
    const workflow = upstreamWorkflow()
    const trace = buildTrace(
      workflow,
      'run',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    // Non-structural: the workflow graph is valid, so a DRAFT can be preserved
    // with the last analysis attached.
    expect(analysis.failureType).not.toBe('STRUCTURAL_ERROR')
    expect(analysis.repairTarget).toBe('UPSTREAM_NODE')
    expect(analysis.analysisId).not.toBe('')
  })

  it('Test R: structural failure blocks commit but keeps the session recoverable', () => {
    // n5 dangles off nothing: t → n3, n5 is an orphan.
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'captcha' }),
        node('n5', 'event-click', { selector: '{{captcha}}' }),
      ],
      [edge('t', 'n3')],
    )
    const trace = buildTrace(
      workflow,
      'run',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: 'x' } },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.repairTarget).toBe('NO_SAFE_REPAIR')
    expect(analysis.failureType).toBe('STRUCTURAL_ERROR')
    // The session (workflow + analysis) is still present and recoverable.
    expect(workflow.drawflow.nodes.length).toBe(3)
  })

  it('Test T: a patch built for an older base workflow fails the optimistic lock', () => {
    const base = upstreamWorkflow()
    const trace = buildTrace(
      base,
      'run',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow: base, trace })

    // The base workflow has SINCE changed: n3.selector is now different.
    const current = structuredClone(base)
    current.drawflow.nodes[1]!.data['selector'] = '.new-producer-selector'

    const stalePatch: WorkflowPatchSet = {
      patchSetId: 'ps',
      analysisId: analysis.analysisId,
      operations: [
        {
          operationId: 'op',
          nodeId: 'n3',
          kind: 'SET_PARAM',
          path: 'selector',
          before: '.old-selector-at-proposal-time',
          after: 'input.code',
          reason: 'r',
          evidenceIds: [],
        },
      ],
      reason: 'r',
      confidence: 0.8,
      expectedEffect: 'e',
    }
    const result = new PatchEngine().validatePatch(current, analysis, stalePatch)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => /stale patch/i.test(issue.message))).toBe(true)
  })

  it('Test U: same workflow + trace → identical analysis regardless of entry', () => {
    const workflow = upstreamWorkflow()
    const debugTrace = buildTrace(
      workflow,
      'runD',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
      ],
      { entry: 'DEBUG' },
    )
    const generationTrace = buildTrace(
      workflow,
      'runG',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'ACTION_ERROR' },
      ],
      { entry: 'GENERATION' },
    )
    const debugAnalysis = analyzeFailure({ workflow, trace: debugTrace })
    const generationAnalysis = analyzeFailure({ workflow, trace: generationTrace })
    expect(sameAnalysis(debugAnalysis, generationAnalysis)).toBe(true)
  })
})
