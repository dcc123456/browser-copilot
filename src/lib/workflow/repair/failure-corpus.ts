/**
 * Offline labeled failure-sample corpus (spec §15 Phase 8 · P2).
 *
 * A fixed, version-controlled set of (workflow, ExecutionTrace) failures with
 * the expected diagnosis. It is the regression guard for §6's root-cause
 * rules: every case the analyzer must distinguish is represented here, so a
 * change that misattributes a symptom as a root cause (the exact bug class
 * §6 warns about) fails the offline suite without needing a live browser.
 *
 * The corpus is intentionally synthetic and redacted — no real secrets.
 *
 * @module lib/workflow/repair/failure-corpus
 */

import type {
  ExecutionTrace,
  NodeExecutionTrace,
  TraceEntry,
  TraceFailure,
  VerificationFailureType,
} from './types'
import type { VariableValueSummary } from './types'
import type { Workflow, WorkflowNode, WorkflowEdge } from '../types'

// --- compact graph builders -------------------------------------------------

export interface SampleNodeSpec {
  id: string
  blockId: string
  data?: Record<string, unknown>
}

/** Build a linear workflow with trigger first; edges default to node order. */
export function buildLinearWorkflow(
  id: string,
  specs: SampleNodeSpec[],
  edges?: [string, string][],
): Workflow {
  const nodes: WorkflowNode[] = specs.map((spec) => ({
    id: spec.id,
    label: spec.blockId,
    position: { x: 0, y: 0 },
    data: { blockId: spec.blockId, ...(spec.data ?? {}) },
  }))
  // Default: chain nodes in order so the graph is connected (spec integrity
  // treats a node without an incoming edge as an orphan/unreachable).
  const chainEdges: [string, string][] =
    edges ?? specs.slice(1).map((spec, index) => [specs[index]!.id, spec.id])
  const flowEdges: WorkflowEdge[] = chainEdges.map(([source, target], index) => ({
    id: `e${index}`,
    source,
    target,
  }))
  return {
    id,
    name: id,
    description: '',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: flowEdges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const summaryOf = (value: {
  exists?: boolean
  isEmpty?: boolean
  type?: string
  length?: number
}): VariableValueSummary => ({
  exists: value.exists ?? true,
  redacted: false,
  ...(value.isEmpty !== undefined ? { isEmpty: value.isEmpty } : {}),
  ...(value.type !== undefined ? { type: value.type } : {}),
  ...(value.length !== undefined ? { length: value.length } : {}),
})

export interface SampleNodeRun {
  nodeId: string
  blockId: string
  status: NodeExecutionTrace['status']
  inputs?: { variable: string; exists?: boolean; isEmpty?: boolean; type?: string }[]
  outputs?: { variable: string; isEmpty?: boolean; type?: string; length?: number }[]
  failure?: TraceFailure
}

let sequence = 0

/**
 * Build a deterministic failed ExecutionTrace from compact node runs.
 */
export function buildTrace(
  workflowId: string,
  entry: TraceEntry,
  runs: SampleNodeRun[],
  failedNodeId: string,
  code: VerificationFailureType,
): ExecutionTrace {
  const nodeExecutions: NodeExecutionTrace[] = runs.map((run) => ({
    nodeId: run.nodeId,
    blockId: run.blockId,
    attempt: 0,
    status: run.status,
    startedAt: 0,
    finishedAt: 0,
    inputVariables: (run.inputs ?? []).map((input) => ({
      variable: input.variable,
      consumerNodeId: run.nodeId,
      paramPath: input.variable,
      resolved: input.exists ?? true,
      summary: summaryOf(input),
    })),
    outputVariables: (run.outputs ?? []).map((output) => ({
      variable: output.variable,
      producerNodeId: run.nodeId,
      summary: summaryOf(output),
    })),
    ...(run.failure ? { error: run.failure } : {}),
  }))

  const failedRun = runs.find((run) => run.nodeId === failedNodeId)
  const failure: TraceFailure = failedRun?.failure ?? {
    code,
    message: `${code} at ${failedNodeId}`,
    nodeId: failedNodeId,
    retryable: false,
    source: 'EXECUTOR',
  }

  return {
    traceId: `trace-${workflowId}`,
    workflowId,
    runId: `run-${workflowId}`,
    entry,
    startedAt: 0,
    finishedAt: 0,
    outcome: 'failed',
    events: runs.map((run) => ({
      sequence: sequence++,
      at: 0,
      kind: run.status === 'failed' ? 'error' : 'status',
      nodeId: run.nodeId,
      text: `${run.nodeId}:${run.status}`,
    })),
    nodeExecutions,
    checkpoints: [],
    finalVariables: {},
    failedNodeId,
    failure,
  }
}

const failure = (code: VerificationFailureType, nodeId: string): TraceFailure => ({
  code,
  message: `${code} at ${nodeId}`,
  nodeId,
  retryable: false,
  source: 'EXECUTOR',
})

// --- the labeled cases (spec §6.4 Case A–F + structure) --------------------

export interface LabeledFailureSample {
  id: string
  description: string
  workflow: Workflow
  trace: ExecutionTrace
  expected: {
    failedNodeId: string
    rootCauseNodeIds: string[]
    repairTarget: import('./types').FailureAnalysis['repairTarget']
    failureType: VerificationFailureType
  }
}

/**
 * The canonical offline corpus. Each entry maps to one spec root-cause case.
 */
export function buildFailureCorpus(): LabeledFailureSample[] {
  // Case A: failed node's own selector error, no bad inputs.
  const aWf = buildLinearWorkflow('caseA', [
    { id: 't', blockId: 'trigger' },
    { id: 'n5', blockId: 'click', data: { selector: '.buy' } },
  ])
  const caseA: LabeledFailureSample = {
    id: 'caseA-failed-node-self',
    description: 'Case A: failed node selector error; root cause is itself',
    workflow: aWf,
    trace: buildTrace(
      'caseA',
      'DEBUG',
      [
        { nodeId: 't', blockId: 'trigger', status: 'ok' },
        {
          nodeId: 'n5',
          blockId: 'click',
          status: 'failed',
          failure: failure('TARGET_AMBIGUOUS', 'n5'),
        },
      ],
      'n5',
      'TARGET_AMBIGUOUS',
    ),
    expected: {
      failedNodeId: 'n5',
      rootCauseNodeIds: ['n5'],
      repairTarget: 'FAILED_NODE',
      failureType: 'TARGET_AMBIGUOUS',
    },
  }

  // Case B: direct upstream produced empty variable.
  const bWf = buildLinearWorkflow('caseB', [
    { id: 't', blockId: 'trigger' },
    { id: 'n3', blockId: 'get-text', data: { variableName: 'captcha' } },
    { id: 'n5', blockId: 'forms', data: { captcha: '{{captcha}}' } },
  ])
  const caseB: LabeledFailureSample = {
    id: 'caseB-upstream-empty',
    description: 'Case B: upstream produced captcha=""; root cause is n3',
    workflow: bWf,
    trace: buildTrace(
      'caseB',
      'GENERATION',
      [
        { nodeId: 't', blockId: 'trigger', status: 'ok' },
        {
          nodeId: 'n3',
          blockId: 'get-text',
          status: 'ok',
          outputs: [{ variable: 'captcha', isEmpty: true, type: 'string', length: 0 }],
        },
        {
          nodeId: 'n5',
          blockId: 'forms',
          status: 'failed',
          inputs: [{ variable: 'captcha', isEmpty: true, type: 'string' }],
          failure: failure('VARIABLE_EMPTY', 'n5'),
        },
      ],
      'n5',
      'VARIABLE_EMPTY',
    ),
    expected: {
      failedNodeId: 'n5',
      rootCauseNodeIds: ['n3'],
      repairTarget: 'UPSTREAM_NODE',
      failureType: 'VARIABLE_EMPTY',
    },
  }

  // Case D: multiple independent roots.
  const dWf = buildLinearWorkflow('caseD', [
    { id: 't', blockId: 'trigger' },
    { id: 'n3', blockId: 'get-text', data: { variableName: 'username' } },
    { id: 'n4', blockId: 'get-text', data: { variableName: 'password' } },
    { id: 'n5', blockId: 'forms', data: { username: '{{username}}', password: '{{password}}' } },
  ])
  const caseD: LabeledFailureSample = {
    id: 'caseD-multiple-roots',
    description: 'Case D: two upstream empty vars; both are root causes',
    workflow: dWf,
    trace: buildTrace(
      'caseD',
      'GENERATION',
      [
        { nodeId: 't', blockId: 'trigger', status: 'ok' },
        {
          nodeId: 'n3',
          blockId: 'get-text',
          status: 'ok',
          outputs: [{ variable: 'username', isEmpty: true, type: 'string', length: 0 }],
        },
        {
          nodeId: 'n4',
          blockId: 'get-text',
          status: 'ok',
          outputs: [{ variable: 'password', isEmpty: true, type: 'string', length: 0 }],
        },
        {
          nodeId: 'n5',
          blockId: 'forms',
          status: 'failed',
          inputs: [
            { variable: 'username', isEmpty: true, type: 'string' },
            { variable: 'password', isEmpty: true, type: 'string' },
          ],
          failure: failure('VARIABLE_EMPTY', 'n5'),
        },
      ],
      'n5',
      'VARIABLE_EMPTY',
    ),
    expected: {
      failedNodeId: 'n5',
      rootCauseNodeIds: ['n3', 'n4'],
      repairTarget: 'MULTIPLE_NODES',
      failureType: 'VARIABLE_EMPTY',
    },
  }

  // Case E: variable valid but consumer misspelled the reference.
  const eWf = buildLinearWorkflow('caseE', [
    { id: 't', blockId: 'trigger' },
    { id: 'n3', blockId: 'get-text', data: { variableName: 'captcha' } },
    { id: 'n5', blockId: 'forms', data: { captcha: '{{captch}}' } },
  ])
  const caseE: LabeledFailureSample = {
    id: 'caseE-consumer-misspelled',
    description: 'Case E: upstream valid; consumer misspelled {{captch}}; root is n5',
    workflow: eWf,
    trace: buildTrace(
      'caseE',
      'DEBUG',
      [
        { nodeId: 't', blockId: 'trigger', status: 'ok' },
        {
          nodeId: 'n3',
          blockId: 'get-text',
          status: 'ok',
          outputs: [{ variable: 'captcha', type: 'string', length: 6 }],
        },
        {
          nodeId: 'n5',
          blockId: 'forms',
          status: 'failed',
          inputs: [{ variable: 'captch', exists: false }],
          failure: failure('VARIABLE_MISSING', 'n5'),
        },
      ],
      'n5',
      'VARIABLE_MISSING',
    ),
    expected: {
      failedNodeId: 'n5',
      rootCauseNodeIds: ['n5'],
      repairTarget: 'FAILED_NODE',
      failureType: 'VARIABLE_MISSING',
    },
  }

  // Case F: CAPTCHA — no safe auto repair.
  const fWf = buildLinearWorkflow('caseF', [
    { id: 't', blockId: 'trigger' },
    { id: 'n5', blockId: 'conditions' },
  ])
  const caseF: LabeledFailureSample = {
    id: 'caseF-no-safe-repair',
    description: 'Case F: CAPTCHA required; no safe automatic repair',
    workflow: fWf,
    trace: buildTrace(
      'caseF',
      'DEBUG',
      [
        { nodeId: 't', blockId: 'trigger', status: 'ok' },
        {
          nodeId: 'n5',
          blockId: 'conditions',
          status: 'failed',
          failure: failure('CAPTCHA_REQUIRED', 'n5'),
        },
      ],
      'n5',
      'CAPTCHA_REQUIRED',
    ),
    expected: {
      failedNodeId: 'n5',
      rootCauseNodeIds: ['n5'],
      repairTarget: 'NO_SAFE_REPAIR',
      failureType: 'CAPTCHA_REQUIRED',
    },
  }

  return [caseA, caseB, caseD, caseE, caseF]
}
