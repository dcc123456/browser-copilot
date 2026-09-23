import { describe, it, expect } from 'vitest'
import {
  createMemoryCheckpointStore,
  checkpointFileName,
  recordCheckpoint,
  rollbackToLastValid,
  restoreVariables,
  resumePointOf,
  type RunCheckpoint,
} from '../src/lib/workflow/checkpoints'
import type { Workflow } from '../src/lib/workflow/types'
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

/**
 * The resume point is what makes a NON-IDEMPOTENT flow recoverable: a login
 * workflow re-run from its trigger hits a form that no longer exists, so a
 * retry has to skip the steps that already landed.
 */
describe('resumePointOf (M4)', () => {
  const workflow = (nodeIds: string[]): Workflow => ({
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: nodeIds.map((id) => ({
        id,
        label: id,
        position: { x: 0, y: 0 },
        data: {},
      })),
      edges: nodeIds.slice(0, -1).map((source, i) => ({
        id: `e${i}`,
        source,
        target: nodeIds[i + 1]!,
      })),
    },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  })

  const at = (stepIndex: number, nodeId: string, status: RunCheckpoint['status'] = 'ok') => ({
    ...cp('r1', stepIndex, status),
    nodeId,
  })

  it('resumes at the node AFTER the last clean step, carrying its variables', () => {
    // trigger → login → dashboard: login succeeded, dashboard never ran.
    const wf = workflow(['trigger', 'login', 'dashboard'])
    const point = resumePointOf(wf, [
      at(0, 'trigger'),
      at(1, 'login', 'ok'),
      at(2, 'dashboard', 'failed'),
    ])
    // Not the trigger — the login must NOT be re-driven.
    expect(point?.kind).toBe('ok')
    expect(point?.kind === 'ok' && point.nodeId).toBe('dashboard')
    expect(point?.kind === 'ok' && point.variables).toEqual({ step: 1 })
    expect(point?.kind === 'ok' && point.fromStepIndex).toBe(1)
  })

  it('ignores a failed tail: resumes at the first step that did NOT settle', () => {
    // b and c both failed, so they prove nothing — the resume point is the
    // node after the last CLEAN step (a), i.e. b gets re-driven.
    const wf = workflow(['a', 'b', 'c'])
    const point = resumePointOf(wf, [at(0, 'a'), at(1, 'b', 'failed'), at(2, 'c', 'failed')])
    expect(point?.kind === 'ok' && point.nodeId).toBe('b')
    expect(point?.kind === 'ok' && point.fromStepIndex).toBe(0)
  })

  it('has no resume point without any clean step', () => {
    const wf = workflow(['a', 'b'])
    expect(resumePointOf(wf, [at(0, 'a', 'failed')])).toBeUndefined()
    expect(resumePointOf(wf, [])).toBeUndefined()
  })

  it('has no resume point when the last clean step is the final node', () => {
    // The run had effectively finished — nothing left to resume.
    const wf = workflow(['a', 'b'])
    expect(resumePointOf(wf, [at(0, 'a'), at(1, 'b')])).toBeUndefined()
  })

  it('has no resume point when the checkpointed node is gone from the graph', () => {
    const wf = workflow(['a', 'b'])
    expect(resumePointOf(wf, [at(0, 'deleted-node')])).toBeUndefined()
  })

  it('prefers the default edge over a branch handle', () => {
    const wf: Workflow = {
      ...workflow(['a', 'b', 'fallback']),
      drawflow: {
        nodes: ['a', 'b', 'fallback'].map((id) => ({
          id,
          label: id,
          position: { x: 0, y: 0 },
          data: {},
        })),
        edges: [
          { id: 'e1', source: 'a', target: 'fallback', sourceHandle: 'fallback' },
          { id: 'e2', source: 'a', target: 'b' },
        ],
      },
    }
    expect(resumePointOf(wf, [at(0, 'a')])?.nodeId).toBe('b')
  })
})

// --- Phase 9: checkpoint phases, terminal-state resume, resume guard ----------

import { workflowFingerprintOf } from '../src/lib/workflow/checkpoints'

describe('workflow fingerprint', () => {
  const makeGraph = makeWorkflowDefer()
  function makeWorkflowDefer() {
    return (nodeIds: string[]): Workflow => ({
      id: 'wf',
      name: 'wf',
      createdAt: 0,
      updatedAt: 0,
      drawflow: {
        nodes: nodeIds.map((id) => ({ id, label: id, position: { x: 0, y: 0 }, data: {} })),
        edges: nodeIds.slice(0, -1).map((source, i) => ({ id: `e${i}`, source, target: nodeIds[i + 1]! })),
      },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    })
  }
  it('is stable for the same graph and changes when the graph changes', () => {
    const wf = makeGraph(['a', 'b'])
    expect(workflowFingerprintOf(wf)).toBe(workflowFingerprintOf(makeGraph(['a', 'b'])))
    expect(workflowFingerprintOf(wf)).not.toBe(workflowFingerprintOf(makeGraph(['a', 'c'])))
  })

  it('changes when node params change but not when canvas position does', () => {
    const wf = makeGraph(['a'])
    wf.drawflow.nodes[0]!.data['selector'] = '.x'
    const before = workflowFingerprintOf(wf)
    wf.drawflow.nodes[0]!.data['selector'] = '.y'
    expect(workflowFingerprintOf(wf)).not.toBe(before)
    wf.drawflow.nodes[0]!.position = { x: 999, y: 999 }
    expect(workflowFingerprintOf(wf)).toBe(workflowFingerprintOf({ ...wf }))
  })
})

describe('phase-aware resume (spec §14)', () => {
  const makeWorkflow = (nodeIds: string[]): Workflow => ({
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: nodeIds.map((id) => ({
        id,
        label: id,
        position: { x: 0, y: 0 },
        data: {},
      })),
      edges: nodeIds.slice(0, -1).map((source, i) => ({
        id: `e${i}`,
        source,
        target: nodeIds[i + 1]!,
      })),
    },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  })
  const wf = makeWorkflow(['a', 'login', 'dashboard'])

  function cp(step: number, node: string, status: RunCheckpoint['status'], phase?: RunCheckpoint['phase']): RunCheckpoint {
    return { runId: 'r', stepIndex: step, nodeId: node, status, variables: {}, at: 0, ...(phase ? { phase } : {}) }
  }

  it('sideEffectStarted without observation → SIDE_EFFECT_UNKNOWN, never a replay point', () => {
    const decision = resumePointOf(wf, [
      cp(0, 'a', 'ok'),
      cp(1, 'login', 'ok', 'sideEffectStarted'),
    ])
    expect(decision?.kind).toBe('side-effect-unknown')
  })

  it('sideEffectObserved counts as committed → resume after the unsafe node', () => {
    const decision = resumePointOf(wf, [
      cp(0, 'a', 'ok'),
      cp(1, 'login', 'ok', 'sideEffectStarted'),
      cp(2, 'login', 'ok', 'sideEffectObserved'),
    ])
    expect(decision?.kind).toBe('ok')
    expect(decision?.kind === 'ok' && decision.nodeId).toBe('dashboard')
  })

  it('nodeStarted alone means the node never committed → resume FROM it', () => {
    const decision = resumePointOf(wf, [cp(0, 'a', 'ok'), cp(1, 'login', 'ok', 'nodeStarted')])
    expect(decision?.kind).toBe('ok')
    expect(decision?.kind === 'ok' && decision.nodeId).toBe('login')
  })

  it('resume guard: a fingerprint mismatch refuses the resume', () => {
    const decision = resumePointOf(wf, [
      { ...cp(0, 'a', 'ok'), workflowFingerprint: 'wf-fp-deadbeef-99' },
    ])
    expect(decision?.kind).toBe('fingerprint-mismatch')
  })

  it('legacy checkpoints without a fingerprint still resume (compat)', () => {
    const decision = resumePointOf(wf, [cp(0, 'a', 'ok')])
    expect(decision?.kind).toBe('ok')
  })

  it('current-graph fingerprints match and resume normally', () => {
    const decision = resumePointOf(wf, [
      { ...cp(0, 'a', 'ok'), workflowFingerprint: workflowFingerprintOf(wf) },
    ])
    expect(decision?.kind).toBe('ok')
    expect(decision?.kind === 'ok' && decision.nodeId).toBe('login')
  })
})
