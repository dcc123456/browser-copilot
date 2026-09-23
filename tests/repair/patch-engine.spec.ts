import { describe, expect, it } from 'vitest'
import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { PatchEngine, PatchRejectedError } from '../../src/lib/workflow/repair/patch-engine'
import type { WorkflowPatchSet } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, makeWorkflow, node } from './helpers'

/** t → n3 get-text captcha → n5 click {{captcha}} */
function upstreamWorkflow() {
  return makeWorkflow(
    [
      node('t', 'trigger'),
      node('n3', 'get-text', { variableName: 'captcha', selector: '.code' }),
      node('n5', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n3'), edge('n3', 'n5')],
  )
}

function analysisForUpstreamEmpty() {
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
  return { workflow, analysis: analyzeFailure({ workflow, trace }) }
}

function patchSet(operations: WorkflowPatchSet['operations']): WorkflowPatchSet {
  return {
    patchSetId: 'ps',
    analysisId: '',
    operations,
    reason: 'r',
    confidence: 0.8,
    expectedEffect: 'e',
  }
}

describe('PatchEngine safety (Test G–K)', () => {
  it('Test G: unrelated nodes stay unchanged after applying an allowed patch', () => {
    const { workflow, analysis } = analysisForUpstreamEmpty()
    const patch = patchSet([
      {
        operationId: 'op1',
        nodeId: 'n3',
        kind: 'SET_PARAM',
        path: 'selector',
        before: '.code',
        after: 'input.code',
        reason: 'read input value',
        evidenceIds: [],
      },
    ])
    const engine = new PatchEngine()
    const validation = engine.validatePatch(workflow, analysis, patch)
    expect(validation.ok).toBe(true)
    const applied = engine.applyPatch(workflow, analysis, patch)
    const tNode = applied.workflow.drawflow.nodes.find((item) => item.id === 't')!
    const n5Node = applied.workflow.drawflow.nodes.find((item) => item.id === 'n5')!
    expect(tNode).toEqual(workflow.drawflow.nodes[0])
    expect(n5Node).toEqual(workflow.drawflow.nodes[2])
    expect(validation.changedNodeIds).toEqual(['n3'])
  })

  it('Test H: a patch on a node outside root-cause scope is rejected', () => {
    const { workflow, analysis } = analysisForUpstreamEmpty()
    const patch = patchSet([
      {
        operationId: 'op1',
        nodeId: 't',
        kind: 'SET_PARAM',
        path: 'type',
        before: undefined,
        after: 'manual',
        reason: 'x',
        evidenceIds: [],
      },
    ])
    const result = new PatchEngine().validatePatch(workflow, analysis, patch)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toContain('outside')
  })

  it('Test I: forging success via protected paths is rejected', () => {
    const { workflow, analysis } = analysisForUpstreamEmpty()
    for (const path of ['onError', 'blockId', 'disableBlock']) {
      const patch = patchSet([
        {
          operationId: 'op1',
          nodeId: 'n3',
          kind: 'SET_PARAM',
          path,
          before: workflow.drawflow.nodes[1]!.data[path],
          after: path === 'onError' ? { continue: true } : 'x',
          reason: 'forge',
          evidenceIds: [],
        },
      ])
      const result = new PatchEngine().validatePatch(workflow, analysis, patch)
      expect(result.ok).toBe(false)
      expect(result.issues[0]?.message).toContain('protected')
    }
  })

  it('Test J: a stale patch (before mismatch) is rejected and requires re-diagnosis', () => {
    const { workflow, analysis } = analysisForUpstreamEmpty()
    const patch = patchSet([
      {
        operationId: 'op1',
        nodeId: 'n3',
        kind: 'SET_PARAM',
        path: 'selector',
        before: '.someone-else-changed-this',
        after: 'input.code',
        reason: 'r',
        evidenceIds: [],
      },
    ])
    const result = new PatchEngine().validatePatch(workflow, analysis, patch)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toContain('Stale patch'.toLowerCase())
  })

  it('Test K: multi-root patch set is atomic — one bad operation rejects the whole set', () => {
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'username' }),
        node('n4', 'get-text', { variableName: 'password' }),
        node('n5', 'forms', { value: '{{username}} {{password}}' }),
      ],
      [edge('t', 'n3'), edge('n3', 'n4'), edge('n4', 'n5')],
    )
    const trace = buildTrace(
      workflow,
      'run',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { username: '' } },
        { id: 'n4', status: 'ok', variables: { username: '', password: '' } },
        { id: 'n5', status: 'failed', variables: { username: '', password: '' }, error: 'e' },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    const patch = patchSet([
      {
        operationId: 'good',
        nodeId: 'n3',
        kind: 'SET_PARAM',
        path: 'selector',
        before: undefined,
        after: '.user',
        reason: 'r',
        evidenceIds: [],
      },
      {
        operationId: 'bad',
        nodeId: 'n4',
        kind: 'SET_PARAM',
        path: 'protectedPath',
        before: undefined,
        after: '.pass',
        reason: 'r',
        evidenceIds: [],
      },
    ])
    const result = new PatchEngine().validatePatch(workflow, analysis, patch)
    expect(result.ok).toBe(false)
    // Nothing applies: applyPatch must throw.
    expect(() => new PatchEngine().applyPatch(workflow, analysis, patch)).toThrow(
      PatchRejectedError,
    )
  })

  it('rejects a patch that would freeze bulk page content into a static data value', () => {
    // Failed node is save-local (a content sink) whose value is the empty
    // upstream variable; a patch that replaces it with a long static value
    // must be blocked by the dynamic-data gate.
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'captcha' }),
        node('n5', 'save-local', { value: '{{captcha}}' }),
      ],
      [edge('t', 'n3'), edge('n3', 'n5')],
    )
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
    const bulk = 'x'.repeat(500)
    const patch = patchSet([
      {
        operationId: 'op1',
        nodeId: 'n5',
        kind: 'SET_PARAM',
        path: 'value',
        before: '{{captcha}}',
        after: bulk,
        reason: 'r',
        evidenceIds: [],
      },
    ])
    const result = new PatchEngine().validatePatch(workflow, analysis, patch)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toContain('freeze bulk')
  })
})
