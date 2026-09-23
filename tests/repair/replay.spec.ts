import { describe, expect, it } from 'vitest'
import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { planReplay } from '../../src/background/workflow-engine/repair/replay-engine'
import { createMemoryCheckpointStore } from '../../src/lib/workflow/checkpoints'
import { recordCheckpoint } from '../../src/lib/workflow/checkpoints'
import { buildTrace, edge, makeWorkflow, node } from './helpers'

/** t → n1 → n2 → n3 (captcha root) → n4 → n5 (symptom) */
function replayWorkflow() {
  return makeWorkflow(
    [
      node('t', 'trigger'),
      node('n1', 'delay', { waitTime: 10 }),
      node('n2', 'get-text', { variableName: 'other' }),
      node('n3', 'get-text', { variableName: 'captcha' }),
      node('n4', 'get-text', { variableName: 'extra' }),
      node('n5', 'event-click', { selector: '{{captcha}}' }),
    ],
    [edge('t', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n3', 'n4'), edge('n4', 'n5')],
  )
}

function executedFor(_workflow?: ReturnType<typeof replayWorkflow>) {
  return [
    { id: 't', status: 'ok' as const, variables: {} },
    { id: 'n1', status: 'ok' as const, variables: {} },
    { id: 'n2', status: 'ok' as const, variables: { other: 'x' } },
    { id: 'n3', status: 'ok' as const, variables: { other: 'x', captcha: '' } },
    { id: 'n4', status: 'ok' as const, variables: { other: 'x', captcha: '', extra: 'y' } },
    {
      id: 'n5',
      status: 'failed' as const,
      variables: { other: 'x', captcha: '', extra: 'y' },
      error: 'ACTION_ERROR',
    },
  ]
}

/** A checkpoint store populated like the production run path would. */
function checkpointStoreFor(
  runId: string,
  workflow: ReturnType<typeof replayWorkflow>,
  upTo: string,
) {
  const store = createMemoryCheckpointStore()
  let variables: Record<string, unknown> = {}
  for (const exec of executedFor(workflow)) {
    variables = exec.variables
    recordCheckpoint(store, {
      runId,
      workflowId: workflow.id,
      stepIndex: workflow.drawflow.nodes.findIndex((item) => item.id === exec.id),
      nodeId: exec.id,
      status: exec.status === 'failed' ? 'failed' : 'ok',
      variables,
      at: 0,
    })
    if (exec.id === upTo) break
  }
  return store
}

describe('Replay planning (Test L–N)', () => {
  it('Test L: replay starts from the last ok checkpoint before the root cause', () => {
    const workflow = replayWorkflow()
    const trace = buildTrace(workflow, 'runL', executedFor(workflow), {})
    const analysis = analyzeFailure({ workflow, trace })
    const store = checkpointStoreFor('runL', workflow, 'n5')
    const decision = planReplay({ workflow, analysis, trace, store })
    expect(decision.kind).toBe('CHECKPOINT')
    expect(decision.checkpoint?.nodeId).toBe('n2')
    expect(decision.startNodeId).toBe('n3')
  })

  it('Test M: no valid checkpoint → falls back to full replay, no fake success', () => {
    const workflow = replayWorkflow()
    const trace = buildTrace(workflow, 'runM', executedFor(workflow), {})
    const analysis = analyzeFailure({ workflow, trace })
    const emptyStore = createMemoryCheckpointStore()
    const decision = planReplay({ workflow, analysis, trace, store: emptyStore })
    expect(decision.kind).toBe('FULL')
    expect(decision.startNodeId).toBe('n3')
  })

  it('Test N: a non-idempotent side effect in the span blocks automatic replay', () => {
    // n4 carries an explicit FORBIDDEN_AUTO_REPLAY safety — the span n3→n5
    // contains an effect that can never be automatically replayed.
    const workflow = replayWorkflow()
    workflow.drawflow.nodes[4] = node('n4', 'webhook', {
      url: 'https://x',
      replaySafety: 'FORBIDDEN_AUTO_REPLAY',
    })
    const trace = buildTrace(workflow, 'runN', executedFor(workflow), {})
    const analysis = analyzeFailure({ workflow, trace })
    const store = checkpointStoreFor('runN', workflow, 'n5')
    const decision = planReplay({ workflow, analysis, trace, store })
    expect(decision.kind).toBe('REQUIRES_CONFIRMATION')
    expect(decision.startNodeId).toBe('n3')
  })
})
