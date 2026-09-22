import { describe, expect, it } from 'vitest'
import { buildVerificationResult } from '../../src/background/workflow-engine/repair/verification-runner'
import {
  verifyThroughRunner,
  type RunnerOutcome,
  type WorkflowRunner,
} from '../../src/background/workflow-engine/repair/verification-runner'
import type { ExecutionTrace } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, makeWorkflow, node } from './helpers'

function simpleWorkflow() {
  return makeWorkflow(
    [node('t', 'trigger'), node('n5', 'event-click', { selector: '.btn' })],
    [edge('t', 'n5')],
  )
}

function traceFor(outcome: RunnerOutcome['outcome'], error?: string): ExecutionTrace {
  const workflow = simpleWorkflow()
  return buildTrace(
    workflow,
    'run',
    [
      { id: 't', status: 'ok', variables: {} },
      ...(outcome === 'ok'
        ? [{ id: 'n5', status: 'ok' as const, variables: {} }]
        : [
            {
              id: 'n5',
              status: 'failed' as const,
              variables: {},
              error: error ?? 'ACTION_ERROR',
            },
          ]),
    ],
    {},
  )
}

describe('Verification semantics (Test O)', () => {
  it('a takeover-free successful run is verified', () => {
    const workflow = simpleWorkflow()
    const trace = traceFor('ok')
    const result = buildVerificationResult({
      workflow,
      outcome: { outcome: 'ok', trace },
      allowedAiTakeover: false,
    })
    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.usedAiTakeover).toBe(false)
  })

  it('Test O: AI takeover completing the task does NOT verify the workflow', () => {
    const workflow = simpleWorkflow()
    const trace: ExecutionTrace = traceFor('ok')
    // Simulate the evidence a takeover leaves in the trace.
    trace.events.push({
      sequence: trace.events.length,
      at: Date.now(),
      kind: 'result',
      nodeId: 'n5',
      text: 'AI 接管完成该步骤',
    })
    const result = buildVerificationResult({
      workflow,
      outcome: { outcome: 'ok', trace },
      allowedAiTakeover: true,
    })
    expect(result.success).toBe(true)
    expect(result.usedAiTakeover).toBe(true)
    expect(result.verified).toBe(false)
  })

  it('goal not achieved → verified=false even on a successful run', () => {
    const workflow = simpleWorkflow()
    const result = buildVerificationResult({
      workflow,
      outcome: { outcome: 'ok', trace: traceFor('ok') },
      allowedAiTakeover: false,
      goalAchieved: false,
    })
    expect(result.verified).toBe(false)
    expect(result.goalAchieved).toBe(false)
  })

  it('verifyThroughRunner: a failing run reports verified=false and the failure type', async () => {
    const workflow = simpleWorkflow()
    const runner: WorkflowRunner = {
      run: async () => ({
        outcome: 'failed',
        error: 'LOCATOR_NOT_FOUND: x',
        trace: traceFor('failed', 'LOCATOR_NOT_FOUND: x'),
      }),
    }
    const result = await verifyThroughRunner(runner, workflow)
    expect(result.verified).toBe(false)
    expect(result.failureType).toBe('TARGET_NOT_FOUND')
  })
})
