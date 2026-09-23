/**
 * Failure analyzer (spec §5.4, §6 · Phase 3).
 *
 * Produces the ONE {@link FailureAnalysis} shared by generation and debug.
 * Deterministic phase only (§6.1): structure, trace, variable evidence and
 * the data flow graph. The entry mode is deliberately NOT part of the input —
 * the same workflow + trace must always produce the same analysis.
 *
 * Analysis order follows §6.2:
 *
 *   1. structure check            — dangling/orphan/unreachable ⇒ STRUCTURAL_ERROR
 *   2. transient classification   — retry first, no patch (§6.3)
 *   3. lock failedNodeId
 *   4. failed node inputs         — resolved / exists / empty / type
 *   5. reverse producer chain     — transform stops the walk (Case C)
 *   6. multiple independent roots
 *   7. replay start node
 *
 * Pure aside from importing lib graph/analysis; no browser or provider.
 *
 * @module background/workflow-engine/repair/failure-analyzer
 */

import { checkWorkflowIntegrity } from '../../../lib/workflow/integrity'
import {
  analyzeDataFlow,
  traceVariableChain,
  type VariableChainLink,
} from '../../../lib/workflow/repair/dataflow-analyzer'
import { classifyVerificationFailure } from '../../../lib/workflow/repair/failure-classifier'
import type {
  DataFlowGraph,
  ExecutionTrace,
  FailureAnalysis,
  PageEvidence,
  RootCauseCandidate,
  VariableEvidence,
} from '../../../lib/workflow/repair/types'
import { isSensitiveName } from '../../../lib/workflow/repair/redaction'
import type { Workflow, WorkflowNode } from '../../../lib/workflow/types'

let analysisCounter = 0
function newAnalysisId(): string {
  analysisCounter = (analysisCounter + 1) % Number.MAX_SAFE_INTEGER
  return `analysis-${Date.now().toString(36)}-${analysisCounter.toString(36)}`
}

/** Failure types a bounded retry should be attempted for BEFORE any patch. */
const TRANSIENT_TYPES: ReadonlySet<string> = new Set([
  'PAGE_NOT_READY',
  'FRAME_NOT_READY',
  'NETWORK_ERROR',
  'WAIT_CONDITION_UNMET',
])

/** Failure types that mean a human must act; no safe automatic repair. */
const HUMAN_TYPES: ReadonlySet<string> = new Set(['AUTH_REQUIRED', 'CAPTCHA_REQUIRED'])

/** Find a node by id. */
function nodeOf(workflow: Workflow, nodeId?: string): WorkflowNode | undefined {
  if (!nodeId) return undefined
  return workflow.drawflow.nodes.find((node) => node.id === nodeId)
}

/** Block id of a node from data, falling back to label. */
function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/**
 * Variable evidence for one input the failed node reads, using trace
 * summaries: missing / empty / type / produced.
 */
function buildVariableEvidence(
  failedNode: WorkflowNode,
  graph: DataFlowGraph,
  trace: ExecutionTrace,
): { rows: VariableEvidence[]; abnormalVariables: string[] } {
  const rows: VariableEvidence[] = []
  const abnormalVariables: string[] = []
  let counter = 0
  const evidenceId = () => `ev-${(counter += 1)}`

  const inputs = graph.consumers
    ? [...graph.consumers.values()].flat().filter((use) => use.consumerNodeId === failedNode.id)
    : []

  // Deterministic order.
  inputs.sort((a, b) =>
    a.variable === b.variable
      ? a.paramPath.localeCompare(b.paramPath)
      : a.variable.localeCompare(b.variable),
  )

  for (const use of inputs) {
    const summary = trace.finalVariables[use.variable]
    const producerExecutions = trace.nodeExecutions.filter((record) =>
      record.outputVariables.some((output) => output.variable === use.variable),
    )
    const lastProduction = producerExecutions[producerExecutions.length - 1]
    // The producer's own output contract (spec §5.3): the deterministic
    // signal that its output is empty / wrong-typed even when it exists.
    const outputContract = lastProduction?.outputVariables.find(
      (output) => output.variable === use.variable,
    )?.contract

    let kind: VariableEvidence['kind'] = 'PRODUCED'
    let detail = `${use.variable} is available`
    if (outputContract && !outputContract.valid) {
      // Contract first: distinguishes EMPTY vs TYPE vs a generic violation.
      const state = outputContract.violations.join('; ')
      if (/empty/.test(state)) {
        kind = 'EMPTY'
        detail = `${use.variable} was produced but is empty (contract: ${state})`
      } else if (/type/.test(state)) {
        kind = 'TYPE'
        detail = `${use.variable} has the wrong type (contract: ${state})`
      } else {
        kind = 'EMPTY'
        detail = `${use.variable} violates its output contract: ${state}`
      }
      abnormalVariables.push(use.variable)
    } else if (!summary?.exists) {
      kind = 'MISSING'
      detail = `${use.variable} was never produced`
      abnormalVariables.push(use.variable)
    } else if (summary.isEmpty) {
      kind = 'EMPTY'
      detail = `${use.variable} was produced but is empty`
      abnormalVariables.push(use.variable)
    } else if (isSensitiveName(use.variable)) {
      detail = `${use.variable} is redacted (sensitive name)`
    }

    rows.push({
      evidenceId: evidenceId(),
      variable: use.variable,
      nodeId: lastProduction?.nodeId,
      kind,
      summary: summary ?? { exists: false, redacted: false },
      ...(outputContract ? { contract: outputContract } : {}),
      detail,
    })
  }

  return { rows, abnormalVariables }
}

/** Page/locator evidence from the trace events for the failed node. */
function buildPageEvidence(failedNode: WorkflowNode, trace: ExecutionTrace): PageEvidence[] {
  const rows: PageEvidence[] = []
  let counter = 0
  const add = (kind: PageEvidence['kind'], detail: string): void => {
    counter += 1
    rows.push({
      evidenceId: `page-${counter}`,
      nodeId: failedNode.id,
      kind,
      detail,
    })
  }
  if (trace.currentUrl) add('URL', trace.currentUrl)
  const selector = failedNode.data?.['selector']
  if (typeof selector === 'string' && selector.trim()) add('SELECTOR', selector)
  return rows
}

/**
 * Determine the earliest node from which a replay is safe: the node
 * immediately BEFORE the earliest root cause along the executed order.
 */
function replayStartOf(
  workflow: Workflow,
  trace: ExecutionTrace,
  rootNodeIds: readonly string[],
): string | undefined {
  const executedOrder = trace.nodeExecutions
    .map((record) => record.nodeId)
    .filter((id, index, all) => all.indexOf(id) === index)
  const rootPositions = rootNodeIds
    .map((id) => executedOrder.indexOf(id))
    .filter((position) => position >= 0)
  if (rootPositions.length === 0) return undefined
  const earliest = Math.min(...rootPositions)
  const before = executedOrder[earliest - 1]
  const beforeNode = nodeOf(workflow, before)
  return beforeNode?.id
}

function chainToDependency(chain: VariableChainLink[]) {
  return chain.map((link) => ({
    ...(link.nodeId ? { nodeId: link.nodeId } : {}),
    variable: link.variable,
    relation:
      link.relation === 'TRANSFORMS'
        ? ('TRANSFORMS_VARIABLE' as const)
        : ('USES_VARIABLE' as const),
  }))
}

export interface AnalyzeInput {
  workflow: Workflow
  trace: ExecutionTrace
}

/**
 * Run the deterministic failure analysis. Always returns a fully populated
 * {@link FailureAnalysis}; the caller decides whether to retry, patch or
 * preserve a draft.
 */
export function analyzeFailure(input: AnalyzeInput): FailureAnalysis {
  const { workflow, trace } = input
  const failedNodeId =
    trace.failedNodeId ?? trace.nodeExecutions.find((record) => record.status === 'failed')?.nodeId
  // The trace failure code may be UNKNOWN when the raw message was never
  // classified at the boundary; re-classify from the message here.
  const failureType =
    trace.failure?.code && trace.failure.code !== 'UNKNOWN'
      ? trace.failure.code
      : trace.failure?.message
        ? classifyVerificationFailure(trace.failure.message).type
        : 'UNKNOWN'

  // 1. Structure first: a graph that does not hang together is a structural
  // error, not a runtime repair target. EXCEPTION (Case E): a dangling
  // reference ON the failed node's own consumer param is a misspelled
  // reference blamed on that node, not a structural defect.
  const integrity = checkWorkflowIntegrity(workflow)
  const danglingElsewhere = integrity.danglingVars.filter((item) => item.nodeId !== failedNodeId)
  const structuralProblem =
    danglingElsewhere.length > 0 ||
    integrity.orphanNodes.length > 0 ||
    integrity.unreachable.length > 0

  const failedNode = nodeOf(workflow, failedNodeId)

  // Build the graph (trace-backed so multi-producer cases resolve).
  const graph = analyzeDataFlow(workflow, trace)

  // Root-cause walk from the failed node along its variable inputs. The trace
  // supplies per-producer output contracts (§5.3) so the walk stops at the
  // first node that actually violated its contract (Case B/C).
  const chainResult = failedNodeId
    ? traceVariableChain(graph, failedNodeId, trace)
    : { chain: [], roots: [], cycle: false }

  const variableResult = failedNode
    ? buildVariableEvidence(failedNode, graph, trace)
    : { rows: [], abnormalVariables: [] }
  const pageEvidenceRows = failedNode ? buildPageEvidence(failedNode, trace) : []

  // --- Decide root cause ------------------------------------------------
  let rootCauseNodeIds: string[] = []
  let repairTarget: FailureAnalysis['repairTarget'] = 'FAILED_NODE'
  let confidence = 0.9
  let retryRecommended = false
  let explanation = ''
  // The reported failure type may be overridden by stronger deterministic
  // evidence (structure / cycle).
  let effectiveFailureType = failureType

  if (structuralProblem || chainResult.cycle) {
    repairTarget = 'NO_SAFE_REPAIR'
    effectiveFailureType = 'STRUCTURAL_ERROR'
    confidence = 0.95
    explanation = chainResult.cycle
      ? 'A circular data dependency was detected; automatic repair is unsafe.'
      : 'The workflow graph is structurally invalid (dangling references / orphan or unreachable nodes).'
  } else if (HUMAN_TYPES.has(failureType)) {
    // Case F: CAPTCHA / 2FA / auth — no safe automatic repair.
    if (failedNodeId) rootCauseNodeIds = [failedNodeId]
    repairTarget = 'NO_SAFE_REPAIR'
    confidence = 0.95
    explanation =
      failureType === 'CAPTCHA_REQUIRED'
        ? 'The failure requires solving a CAPTCHA, which the repair loop must not bypass.'
        : 'The failure requires user authentication / 2FA, which the repair loop must not bypass.'
  } else if (TRANSIENT_TYPES.has(failureType) && trace.failure?.retryable !== false) {
    // §6.3 transient: recommend a bounded retry BEFORE any patch.
    if (failedNodeId) rootCauseNodeIds = [failedNodeId]
    retryRecommended = true
    repairTarget = 'FAILED_NODE'
    confidence = 0.6
    explanation =
      'The failure looks transient (page/frame not ready, network or wait condition); a bounded retry is recommended before patching.'
  } else if (!failedNode) {
    repairTarget = 'NO_SAFE_REPAIR'
    confidence = 0.4
    explanation = 'The failed node could not be located in the workflow graph.'
  } else if (variableResult.abnormalVariables.length > 0 && chainResult.roots.length > 0) {
    // Cases B / C / D: one or more upstream producers are the root cause.
    // traceVariableChain already stops at the offending transform (Case C),
    // so its roots ARE the responsible producers.
    rootCauseNodeIds = [...chainResult.roots]
    repairTarget = rootCauseNodeIds.length > 1 ? 'MULTIPLE_NODES' : 'UPSTREAM_NODE'
    confidence = 0.85
    explanation =
      rootCauseNodeIds.length > 1
        ? 'Multiple upstream variables are invalid; each producing node is an independent root cause.'
        : 'The failed node reads an invalid variable; the node producing it is the root cause.'
  } else {
    // Case A / E: the failed node itself — its own selector/action, or an
    // input reference whose name nothing produces (Case E consumer typo).
    rootCauseNodeIds = [failedNode.id]
    repairTarget = 'FAILED_NODE'
    confidence = 0.85
    explanation =
      'The failed node has no abnormal input variable; its own configuration (locator / action / reference) is the root cause.'
  }

  // Deduplicate + deterministic order.
  rootCauseNodeIds = [...new Set(rootCauseNodeIds)].sort()

  const replayFromNodeId =
    repairTarget === 'UPSTREAM_NODE' || repairTarget === 'MULTIPLE_NODES'
      ? replayStartOf(workflow, trace, rootCauseNodeIds)
      : undefined

  const alternatives: RootCauseCandidate[] = rootCauseNodeIds.map((nodeId) => ({
    nodeId,
    reason: nodeId === failedNodeId ? 'failed node itself' : 'upstream variable producer',
    confidence,
    evidenceIds: variableResult.rows
      .filter((row) => row.nodeId === nodeId)
      .map((row) => row.evidenceId),
  }))

  return {
    analysisVersion: 1,
    analysisId: newAnalysisId(),
    failedNodeId: failedNodeId ?? '',
    rootCauseNodeIds,
    failureType: effectiveFailureType,
    repairTarget,
    dependencyChain: chainToDependency(chainResult.chain),
    variableEvidence: variableResult.rows,
    pageEvidence: pageEvidenceRows,
    alternatives,
    explanation,
    confidence,
    retryRecommended,
    ...(replayFromNodeId ? { replayFromNodeId } : {}),
  }
}

export { blockIdOf }
