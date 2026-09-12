import { describe, it, expect } from 'vitest'
import {
  createMemoryCheckpointStore,
  checkpointFileName,
  recordCheckpoint,
  rollbackToLastValid,
  restoreVariables,
  type RunCheckpoint,
} from '../src/lib/workflow/checkpoints'
import {
  createMemoryFailureStore,
  rememberFailure,
  buildFailureMemoryHint,
} from '../src/lib/workflow/failure-memory'

const cp = (runId: string, stepIndex: number, status: RunCheckpoint['status']): RunCheckpoint => ({
  runId,
  stepIndex,
  status,
  variables: { step: stepIndex },
  at: stepIndex,
})

describe('checkpoints (M4)', () => {
  it('records and loads a run in step order', () => {
    const store = createMemoryCheckpointStore()
    recordCheckpoint(store, cp('r1', 0, 'ok'))
    recordCheckpoint(store, cp('r1', 1, 'running'))
    expect(store.load('r1').map((c) => c.stepIndex)).toEqual([0, 1])
    expect(store.latest('r1')?.stepIndex).toBe(1)
  })

  it('rolls back to the last non-failed checkpoint', () => {
    const store = createMemoryCheckpointStore()
    recordCheckpoint(store, cp('r1', 0, 'ok'))
    recordCheckpoint(store, cp('r1', 1, 'ok'))
    recordCheckpoint(store, cp('r1', 2, 'failed'))
    const rolled = rollbackToLastValid(store, 'r1')
    expect(rolled?.stepIndex).toBe(1)
  })

  it('returns no rollback point when every step failed', () => {
    const store = createMemoryCheckpointStore()
    recordCheckpoint(store, cp('r1', 0, 'failed'))
    expect(rollbackToLastValid(store, 'r1')).toBeUndefined()
  })

  it('restores variables from a checkpoint', () => {
    const store = createMemoryCheckpointStore()
    recordCheckpoint(store, { ...cp('r1', 0, 'ok'), variables: { a: 1 } })
    expect(restoreVariables(store.latest('r1'))).toEqual({ a: 1 })
    expect(restoreVariables(undefined)).toEqual({})
  })

  it('caps retained checkpoints per run', () => {
    const store = createMemoryCheckpointStore(2)
    for (let i = 0; i < 5; i++) recordCheckpoint(store, cp('r1', i, 'ok'))
    expect(store.load('r1').map((c) => c.stepIndex)).toEqual([3, 4])
  })

  it('names checkpoint files with the shared convention', () => {
    expect(checkpointFileName('run-42')).toBe('checkpoint-run-42.json')
  })
})

describe('failure memory (M4)', () => {
  it('derives a signature and counts repeat failures', () => {
    const store = createMemoryFailureStore()
    // Same text modulo case/whitespace → same signature (failureSignature
    // lowercases and collapses whitespace before slicing).
    rememberFailure(store, { nodeId: 'n1', error: 'element not found' })
    rememberFailure(store, { nodeId: 'n1', error: '  Element   Not Found  ' })
    const entries = store.query({ nodeId: 'n1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.occurrences).toBe(2)
  })

  it('queries by workflow and node', () => {
    const store = createMemoryFailureStore()
    rememberFailure(store, { workflowId: 'w1', nodeId: 'n1', error: 'boom' })
    rememberFailure(store, { workflowId: 'w2', nodeId: 'n2', error: 'boom' })
    expect(store.query({ workflowId: 'w1' })).toHaveLength(1)
    expect(store.query({ nodeId: 'n2' })[0]?.nodeId).toBe('n2')
  })

  it('renders a prompt hint only when there is something to say', () => {
    const store = createMemoryFailureStore()
    expect(buildFailureMemoryHint([])).toBeUndefined()
    rememberFailure(store, {
      nodeId: 'n1',
      error: 'not found',
      rootCause: '选择器过期',
      suggestedAction: '改用稳定选择器',
      confidence: 0.8,
    })
    const hint = buildFailureMemoryHint(store.query({ nodeId: 'n1' }))
    expect(hint).toContain('失败记忆')
    expect(hint).toContain('选择器过期')
    expect(hint).toContain('改用稳定选择器')
  })
})
