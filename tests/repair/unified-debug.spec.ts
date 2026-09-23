import { describe, expect, it } from 'vitest'
import { runUnifiedDebug } from '../../src/background/workflow-engine/repair/unified-debug'
import { finalizeGeneratedWorkflow } from '../../src/background/workflow-engine/repair/generation-repair'
import type { RepairContext, WorkflowPatchSet } from '../../src/lib/workflow/repair/types'
import { createMemoryCheckpointStore } from '../../src/lib/workflow/checkpoints'
import { recordCheckpoint } from '../../src/lib/workflow/checkpoints'
import { TraceCollector } from '../../src/lib/workflow/execution-trace'
import type {
  RunnerOutcome,
  WorkflowRunner,
} from '../../src/background/workflow-engine/repair/verification-runner'
import { edge, makeWorkflow, node } from './helpers'

/** t → n3 get-text captcha → n5 click {{captcha}} */
function workflow() {
  return makeWorkflow(
    [
      node('t', 'trigger'),
      node('n3', 'get-text', { variableName: 'captcha', selector: '.code' }),
      node('n5', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n3'), edge('n3', 'n5')],
  )
}

/** Build the trace a failed execution produces (via the real collector). */
function failedTrace(runId: string, variables: Record<string, unknown>) {
  const wf = workflow()
  const collector = new TraceCollector({ workflowId: wf.id, runId, entry: 'DEBUG' })
  let incoming: Record<string, unknown> = {}
  const spec: [string, Record<string, unknown>, boolean][] = [
    ['t', {}, false],
    ['n3', variables, false],
    ['n5', variables, true],
  ]
  for (const [id, after, failed] of spec) {
    const wfNode = wf.drawflow.nodes.find((item) => item.id === id)!
    collector.startNode(wfNode, incoming)
    if (failed) {
      collector.finishNode(wfNode, 'failed', incoming, after, {
        code: 'ACTION_ERROR',
        message: 'ACTION_ERROR',
        nodeId: id,
        retryable: true,
        source: 'EXECUTOR',
      })
    } else {
      collector.finishNode(wfNode, 'ok', incoming, after)
    }
    incoming = after
  }
  return collector.build('failed', variables, {
    code: 'ACTION_ERROR',
    message: 'ACTION_ERROR',
    nodeId: 'n5',
    retryable: true,
    source: 'EXECUTOR',
  })
}

function okTrace(runId: string) {
  const wf = workflow()
  const collector = new TraceCollector({ workflowId: wf.id, runId, entry: 'DEBUG' })
  let incoming: Record<string, unknown> = {}
  const spec: [string, Record<string, unknown>][] = [
    ['t', {}],
    ['n3', { captcha: 'good' }],
    ['n5', { captcha: 'good' }],
  ]
  for (const [id, after] of spec) {
    const wfNode = wf.drawflow.nodes.find((item) => item.id === id)!
    collector.startNode(wfNode, incoming)
    collector.finishNode(wfNode, 'ok', incoming, after)
    incoming = after
  }
  return collector.build('ok', incoming)
}

/** A runner whose first call fails then, when patched, succeeds. */
function scriptedRunner(first: RunnerOutcome, later: RunnerOutcome): WorkflowRunner {
  let calls = 0
  return {
    run: async () => {
      calls += 1
      if (calls === 1) return first
      return later
    },
  }
}

/** A provider that proposes fixing n3.selector. */
function provider(patch: WorkflowPatchSet) {
  return async (_context: RepairContext) => patch
}

const fixPatch = (): WorkflowPatchSet => ({
  patchSetId: 'ps',
  analysisId: '',
  operations: [
    {
      operationId: 'op',
      nodeId: 'n3',
      kind: 'SET_PARAM',
      path: 'selector',
      before: '.code',
      after: 'input.code',
      reason: 'read value instead of text',
      evidenceIds: ['ev-1'],
    },
  ],
  reason: 'captcha producer reads wrong property',
  confidence: 0.85,
  expectedEffect: 'captcha becomes non-empty',
})

describe('unified debug orchestration', () => {
  it('ANALYZE runs + diagnoses without producing a patch or changing the workflow', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'ok', trace: okTrace('r2') },
    )
    const before = JSON.stringify(wf)
    const result = await runUnifiedDebug(wf, 'ANALYZE', {
      runner,
      store: createMemoryCheckpointStore(),
      propose: provider(fixPatch()),
    })
    expect(result.mode).toBe('ANALYZE')
    expect(result.patch).toBeUndefined()
    expect(result.workingCopy).toBeUndefined()
    expect(JSON.stringify(wf)).toBe(before)
    expect(result.analysis.rootCauseNodeIds).toEqual(['n3'])
  })

  it('SUGGEST returns a validated, previewable patch without applying it', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'ok', trace: okTrace('r2') },
    )
    const result = await runUnifiedDebug(wf, 'SUGGEST', {
      runner,
      store: createMemoryCheckpointStore(),
      propose: provider(fixPatch()),
    })
    expect(result.ok).toBe(true)
    expect(result.patch?.operations).toHaveLength(1)
    expect(result.workingCopy).toBeUndefined()
  })

  it('AUTO_REPAIR applies, replays and verifies; formal workflow is untouched', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    // First verify fails; replay (call 2) succeeds.
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'ok', trace: okTrace('r2') },
    )
    const store = createMemoryCheckpointStore()
    // Record the n3 ok checkpoint so replay planning can resolve.
    recordCheckpoint(store, {
      runId: 'r1',
      workflowId: wf.id,
      stepIndex: 1,
      nodeId: 'n3',
      status: 'ok',
      variables: { captcha: '' },
      at: 0,
    })
    const result = await runUnifiedDebug(wf, 'AUTO_REPAIR', {
      runner,
      store,
      propose: provider(fixPatch()),
    })
    expect(result.ok).toBe(true)
    expect(result.workingCopy).toBeDefined()
    expect(result.workingCopy).not.toBe(wf)
    expect(result.verification.verified).toBe(true)
    // The formal workflow passed in is still the unpatched one.
    expect(wf.drawflow.nodes[1]!.data['selector']).toBe('.code')
  })

  it('degrades honestly when no provider is available', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'ok', trace: okTrace('r2') },
    )
    const result = await runUnifiedDebug(wf, 'AUTO_REPAIR', {
      runner,
      store: createMemoryCheckpointStore(),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('provider unavailable')
  })
})

describe('generation repair loop', () => {
  it('returns VERIFIED after a patched replay succeeds', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'ok', trace: okTrace('r2') },
    )
    const store = createMemoryCheckpointStore()
    const result = await finalizeGeneratedWorkflow(wf, {
      runner,
      store,
      propose: provider(fixPatch()),
    })
    expect(result.status).toBe('VERIFIED')
    expect(result.workingCopy.drawflow.nodes[1]!.data['selector']).toBe('input.code')
  })

  it('returns DRAFT when the repair budget is exhausted with a non-structural failure', async () => {
    const wf = workflow()
    const trace = failedTrace('r1', { captcha: '' })
    // Always fail, regardless of the patch.
    const runner = scriptedRunner(
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
      { outcome: 'failed', error: 'ACTION_ERROR', trace },
    )
    const result = await finalizeGeneratedWorkflow(wf, {
      runner,
      store: createMemoryCheckpointStore(),
      propose: provider(fixPatch()),
      policy: { maxRepairRounds: 1 },
    })
    expect(['DRAFT', 'BLOCKED']).toContain(result.status)
    expect(result.workingCopy).toBeDefined()
  })
})
