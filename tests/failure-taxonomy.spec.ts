/**
 * Unified workflow failure taxonomy tests (计划 T00.6).
 *
 * The taxonomy is the single object shape later Validators, the deterministic
 * repair library and the debug loop all consume — these tests pin its vocabulary,
 * the mapping from the two pre-existing failure vocabularies, and the default
 * safety decisions (especially: side-effect / goal failures are never blind-retryable).
 */
import { describe, expect, it } from 'vitest'

import {
  FAILURE_KINDS,
  classifyWorkflowFailure,
  describeWorkflowFailure,
  isWorkflowFailureKind,
  kindFromFailureCode,
  kindFromVerificationFailure,
} from '../src/lib/workflow/failure-taxonomy'

import type { WorkflowFailure, WorkflowFailureKind } from '../src/lib/workflow/failure-taxonomy'

const EXPECTED_KINDS: WorkflowFailureKind[] = [
  'intent',
  'planning',
  'graph',
  'dataflow',
  'locator-not-found',
  'locator-ambiguous',
  'locator-unstable',
  'readiness',
  'page-state',
  'wrong-origin',
  'navigation',
  'side-effect',
  'goal-verification',
  'runtime',
  'environment',
  'unknown',
]

describe('unified workflow failure taxonomy', () => {
  it('exposes exactly the 16 planned failure kinds', () => {
    expect([...FAILURE_KINDS]).toEqual(EXPECTED_KINDS)
    expect(isWorkflowFailureKind('locator-not-found')).toBe(true)
    expect(isWorkflowFailureKind('not-a-kind')).toBe(false)
    expect(isWorkflowFailureKind(undefined)).toBe(false)
  })

  it('builds a complete WorkflowFailure with kind-derived defaults', () => {
    const failure: WorkflowFailure = classifyWorkflowFailure({
      kind: 'locator-not-found',
      nodeId: 'save',
      runId: 'run-1',
      message: '元素未找到: #save',
      evidence: { selector: '#save' },
    })
    expect(failure.kind).toBe('locator-not-found')
    expect(failure.nodeId).toBe('save')
    expect(failure.runId).toBe('run-1')
    expect(failure.evidence).toMatchObject({ selector: '#save' })
    // The message is preserved as evidence, not discarded.
    expect(failure.evidence['message']).toBe('元素未找到: #save')
    // Locator failures are bounded-retryable and repairable.
    expect(failure.retryable).toBe(true)
    expect(failure.repairable).toBe(true)
    expect(failure.unsafeToRetry).toBe(false)
  })

  it('never marks a side-effect failure as blind-retryable', () => {
    const failure = classifyWorkflowFailure({ kind: 'side-effect', message: 'submit failed' })
    expect(failure.retryable).toBe(false)
    expect(failure.repairable).toBe(false)
    expect(failure.unsafeToRetry).toBe(true)
  })

  it('treats goal-verification failures as unsafe to blindly retry', () => {
    const failure = classifyWorkflowFailure({ kind: 'goal-verification' })
    expect(failure.unsafeToRetry).toBe(true)
    expect(failure.repairable).toBe(true)
  })

  it('maps the legacy FailureCode vocabulary onto unified kinds', () => {
    expect(kindFromFailureCode('LOCATOR_NOT_FOUND')).toBe('locator-not-found')
    expect(kindFromFailureCode('ELEMENT_NOT_FOUND')).toBe('locator-not-found')
    expect(kindFromFailureCode('LOCATOR_AMBIGUOUS')).toBe('locator-ambiguous')
    expect(kindFromFailureCode('READINESS_TIMEOUT')).toBe('readiness')
    expect(kindFromFailureCode('TIMEOUT')).toBe('readiness')
    expect(kindFromFailureCode('SIDE_EFFECT_UNSAFE')).toBe('side-effect')
    expect(kindFromFailureCode('TERMINAL_STATE_UNCERTAIN')).toBe('side-effect')
    expect(kindFromFailureCode('WRONG_ORIGIN')).toBe('wrong-origin')
    expect(kindFromFailureCode('WRONG_PAGE')).toBe('wrong-origin')
    expect(kindFromFailureCode('VALIDATION_FAILED')).toBe('graph')
    expect(kindFromFailureCode('GOAL_NOT_ACHIEVED')).toBe('goal-verification')
    expect(kindFromFailureCode('POSTCONDITION_FAILED')).toBe('goal-verification')
    expect(kindFromFailureCode('PRECONDITION_FAILED')).toBe('page-state')
    expect(kindFromFailureCode('ABORTED')).toBe('unknown')
    expect(kindFromFailureCode('UNKNOWN')).toBe('unknown')
  })

  it('maps the VerificationFailureType vocabulary onto unified kinds', () => {
    expect(kindFromVerificationFailure('TARGET_NOT_FOUND')).toBe('locator-not-found')
    expect(kindFromVerificationFailure('TARGET_AMBIGUOUS')).toBe('locator-ambiguous')
    expect(kindFromVerificationFailure('PAGE_NOT_READY')).toBe('readiness')
    expect(kindFromVerificationFailure('FRAME_NOT_READY')).toBe('readiness')
    expect(kindFromVerificationFailure('WAIT_CONDITION_UNMET')).toBe('readiness')
    expect(kindFromVerificationFailure('VARIABLE_MISSING')).toBe('dataflow')
    expect(kindFromVerificationFailure('VARIABLE_EMPTY')).toBe('dataflow')
    expect(kindFromVerificationFailure('VARIABLE_TYPE_ERROR')).toBe('dataflow')
    expect(kindFromVerificationFailure('CONTRACT_VIOLATION')).toBe('page-state')
    expect(kindFromVerificationFailure('PRECONDITION_FAILED')).toBe('page-state')
    expect(kindFromVerificationFailure('POSTCONDITION_FAILED')).toBe('goal-verification')
    expect(kindFromVerificationFailure('GOAL_NOT_ACHIEVED')).toBe('goal-verification')
    expect(kindFromVerificationFailure('WRONG_ORIGIN')).toBe('wrong-origin')
    expect(kindFromVerificationFailure('WRONG_PAGE')).toBe('wrong-origin')
    expect(kindFromVerificationFailure('SIDE_EFFECT_UNSAFE')).toBe('side-effect')
    expect(kindFromVerificationFailure('AUTH_REQUIRED')).toBe('environment')
    expect(kindFromVerificationFailure('CAPTCHA_REQUIRED')).toBe('environment')
    expect(kindFromVerificationFailure('NETWORK_ERROR')).toBe('environment')
    expect(kindFromVerificationFailure('STRUCTURAL_ERROR')).toBe('graph')
    expect(kindFromVerificationFailure('ACTION_ERROR')).toBe('runtime')
    expect(kindFromVerificationFailure('CANCELLED')).toBe('unknown')
    expect(kindFromVerificationFailure('UNKNOWN')).toBe('unknown')
  })

  it('renders a concise developer-facing description', () => {
    const failure = classifyWorkflowFailure({
      kind: 'dataflow',
      nodeId: 'n1',
      runId: 'r1',
      message: 'customer is unwritten',
    })
    const text = describeWorkflowFailure(failure)
    expect(text).toContain('dataflow')
    expect(text).toContain('n1')
    expect(text).toContain('r1')
    expect(text).toContain('customer is unwritten')
  })

  it('defaults evidence to an empty object and tolerates missing fields', () => {
    const failure = classifyWorkflowFailure({ kind: 'unknown' })
    expect(failure.evidence).toEqual({})
    expect(failure.nodeId).toBeUndefined()
    expect(failure.runId).toBeUndefined()
  })
})
