import { describe, expect, it } from 'vitest'
import { classifyRunFailure } from '../src/background/workflow-engine/recovery-classifier'
import { makeWorkflow, node, edge } from './repair/helpers'
import type { ExecutionTrace, TraceFailure } from '../src/lib/workflow/repair/types'
import type { ResumeDecision } from '../src/lib/workflow/checkpoints'
import type { Workflow } from '../src/lib/workflow/types'

/** Two nodes after the trigger; n5 is the failing one. */
function workflow(): Workflow {
  return makeWorkflow(
    [node('t', 'trigger'), node('n3', 'forms'), node('n5', 'event-click', { selector: '.go' })],
    [edge('t', 'n3'), edge('n3', 'n5')],
  )
}

/** Minimal failed trace with an explicit structured runner failure. */
function traceWithFailure(failure: TraceFailure, failedNodeId = 'n5'): ExecutionTrace {
  return {
    traceId: 'tr',
    workflowId: 'wf',
    runId: 'r1',
    entry: 'DEBUG',
    startedAt: 0,
    outcome: 'failed',
    events: [],
    nodeExecutions: [
      {
        nodeId: failedNodeId,
        blockId: 'event-click',
        attempt: 1,
        status: 'failed',
        inputVariables: [],
        outputVariables: [],
        error: failure,
      },
    ],
    checkpoints: [],
    finalVariables: {},
    failedNodeId,
    failure,
  }
}

const traceFailure = (
  code: TraceFailure['code'],
  message: string,
  retryable: boolean,
): TraceFailure => ({
  code,
  message,
  nodeId: 'n5',
  retryable,
  source: 'EXECUTOR',
})

/** A trace with NO structured source — only an external observation. */
function bareTrace(): ExecutionTrace {
  return {
    traceId: 'tr',
    workflowId: 'wf',
    runId: 'r1',
    entry: 'DEBUG',
    startedAt: 0,
    outcome: 'failed',
    events: [],
    nodeExecutions: [],
    checkpoints: [],
    finalVariables: {},
    failedNodeId: 'n5',
  }
}

describe('classifyRunFailure', () => {
  it('classifies a locator-not-found as LOCATOR / SUGGEST / PATCH_LOCATOR', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('TARGET_NOT_FOUND', 'TARGET_NOT_FOUND: .go', false)),
    })
    expect(result.failedNodeId).toBe('n5')
    expect(result.category).toBe('LOCATOR')
    expect(result.recoverability).toBe('SUGGEST')
    expect(result.recommendedAction.kind).toBe('PATCH_LOCATOR')
    expect(result.confidence).toBeCloseTo(0.9)
    expect(result.evidence.some((e) => e.kind === 'RUNNER_CODE')).toBe(true)
  })

  it('classifies a slow page as TIMING / AUTO / RETRY', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('PAGE_NOT_READY', 'PAGE_NOT_READY', true)),
    })
    expect(result.category).toBe('TIMING')
    expect(result.recoverability).toBe('AUTO')
    expect(result.recommendedAction.kind).toBe('RETRY')
  })

  it('classifies network errors as NETWORK / AUTO / RETRY', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('NETWORK_ERROR', 'fetch failed', true)),
    })
    expect(result.category).toBe('NETWORK')
    expect(result.recoverability).toBe('AUTO')
    expect(result.recommendedAction.kind).toBe('RETRY')
  })

  it('classifies missing variables as DATA / SUGGEST / PROVIDE_DATA', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('VARIABLE_MISSING', 'orderId missing', false)),
    })
    expect(result.category).toBe('DATA')
    expect(result.recoverability).toBe('SUGGEST')
    expect(result.recommendedAction.kind).toBe('PROVIDE_DATA')
  })

  it('always treats auth as HUMAN / REQUEST_LOGIN', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('AUTH_REQUIRED', 'login required', false)),
    })
    expect(result.category).toBe('AUTH')
    expect(result.recoverability).toBe('HUMAN')
    expect(result.recommendedAction.kind).toBe('REQUEST_LOGIN')
  })

  it('always treats captcha as HUMAN / REQUEST_CAPTCHA', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('CAPTCHA_REQUIRED', 'captcha', false)),
    })
    expect(result.category).toBe('CAPTCHA')
    expect(result.recoverability).toBe('HUMAN')
    expect(result.recommendedAction.kind).toBe('REQUEST_CAPTCHA')
  })

  it('hard-blocks when checkpoints say side-effect-unknown', () => {
    const decision: ResumeDecision = { kind: 'side-effect-unknown', nodeId: 'n5', stepIndex: 4 }
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('TARGET_NOT_FOUND', '.go', false)),
      resumeDecision: decision,
    })
    expect(result.category).toBe('SIDE_EFFECT')
    expect(result.recoverability).toBe('BLOCKED')
    expect(result.recommendedAction.kind).toBe('BLOCK_SIDE_EFFECT')
    expect(result.safeResumePoint).toBeUndefined()
  })

  it('treats a fingerprint mismatch as STRUCTURAL', () => {
    const decision: ResumeDecision = { kind: 'fingerprint-mismatch', nodeId: 'n5', stepIndex: 4 }
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('TARGET_NOT_FOUND', '.go', false)),
      resumeDecision: decision,
    })
    expect(result.category).toBe('STRUCTURAL')
  })

  it('upgrades to RESUME with a proven safe checkpoint point', () => {
    const decision: ResumeDecision = {
      kind: 'ok',
      nodeId: 'n5',
      variables: { a: 1 },
      fromStepIndex: 2,
    }
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('TARGET_NOT_FOUND', '.go', false)),
      resumeDecision: decision,
    })
    expect(result.recoverability).toBe('RESUME')
    expect(result.recommendedAction.kind).toBe('RESUME_CHECKPOINT')
    expect(result.safeResumePoint).toEqual({ nodeId: 'n5', stepIndex: 2, variables: { a: 1 } })
  })

  it('never claims AUTO from a pure-string / observation-only failure', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: bareTrace(),
      observation: { nodeId: 'n5', detail: 'looks like a timeout' },
    })
    expect(result.category).toBe('UNKNOWN')
    expect(result.recoverability).toBe('SUGGEST')
    expect(result.confidence).toBeCloseTo(0.42)
  })

  it('degrades to UNKNOWN with low confidence when there is no evidence at all', () => {
    const result = classifyRunFailure({ workflow: workflow(), trace: bareTrace() })
    expect(result.category).toBe('UNKNOWN')
    expect(result.confidence).toBeLessThan(0.5)
  })

  it('ranks strong evidence above an AI observation', () => {
    const result = classifyRunFailure({
      workflow: workflow(),
      trace: traceWithFailure(traceFailure('TARGET_NOT_FOUND', '.go', false)),
      observation: { detail: 'the model thinks it is a network issue' },
    })
    expect(result.category).toBe('LOCATOR')
    expect(result.confidence).toBeCloseTo(0.9)
  })
})
