/**
 * Lightweight, serializable repair outcome for the panel (spec §10, §12).
 *
 * The full {@link FailureAnalysis} / {@link VerificationResult} carry the
 * whole trace and working copy. Messages must stay small and must not ship the
 * trace or the workflow, so this module is the projection the message layer
 * sends and the UI renders. Kept in `lib` (no browser dependency) so
 * `messages.ts` can reference it.
 *
 * @module lib/workflow/repair/repair-response
 */

import type {
  FailureAnalysis,
  VariableEvidence,
  VerificationResult,
  WorkflowPatchOperation,
} from './types'

/** One variable dependency row for the UI (failed node vs root cause). */
export interface RepairVariableRow {
  variable: string
  producerNodeId?: string
  status: 'ok' | 'missing' | 'empty' | 'type'
}

/** One patch row for the preview (before → after). */
export interface RepairPatchRow {
  nodeId: string
  path: string
  before?: unknown
  after?: unknown
  reason: string
}

export interface RepairResponseData {
  /** Workflow this repair belongs to (needed by the panel commit/discard). */
  workflowId: string
  mode: 'ANALYZE' | 'SUGGEST' | 'AUTO_REPAIR'
  ok: boolean
  verified: boolean

  failedNodeId: string
  rootCauseNodeIds: string[]
  failureType: string
  repairTarget: FailureAnalysis['repairTarget']

  explanation: string
  confidence: number
  retryRecommended: boolean
  replayFromNodeId?: string

  variableRows: RepairVariableRow[]
  patchRows: RepairPatchRow[]
  warnings: string[]
  error?: string
  reason?: string
  /**
   * A low-confidence valid patch awaits explicit confirmation (P2). Nothing was
   * applied; the panel re-sends AUTO_REPAIR after the user confirms.
   */
  needsConfirmation?: boolean
}

function evidenceStatus(row: VariableEvidence): RepairVariableRow['status'] {
  if (row.kind === 'MISSING') return 'missing'
  if (row.kind === 'EMPTY') return 'empty'
  if (row.kind === 'TYPE') return 'type'
  return 'ok'
}

/** Project the full analysis + verification into the wire response. */
export function toRepairResponse(
  workflowId: string,
  analysis: FailureAnalysis,
  verification: VerificationResult,
  mode: RepairResponseData['mode'],
  operations: readonly WorkflowPatchOperation[] = [],
  extra: { ok?: boolean; reason?: string; needsConfirmation?: boolean } = {},
): RepairResponseData {
  const producerOf = new Map<string, string | undefined>()
  for (const row of analysis.variableEvidence) {
    producerOf.set(row.variable, row.nodeId)
  }
  return {
    workflowId,
    mode,
    ok: extra.ok ?? verification.verified,
    verified: verification.verified,
    failedNodeId: analysis.failedNodeId,
    rootCauseNodeIds: [...analysis.rootCauseNodeIds],
    failureType: analysis.failureType,
    repairTarget: analysis.repairTarget,
    explanation: analysis.explanation,
    confidence: analysis.confidence,
    retryRecommended: analysis.retryRecommended,
    ...(analysis.replayFromNodeId ? { replayFromNodeId: analysis.replayFromNodeId } : {}),
    variableRows: analysis.variableEvidence.map((row) => ({
      variable: row.variable,
      ...(producerOf.get(row.variable) ? { producerNodeId: producerOf.get(row.variable) } : {}),
      status: evidenceStatus(row),
    })),
    patchRows: operations.map((operation) => ({
      nodeId: operation.nodeId,
      path: operation.path ?? '',
      ...(operation.before !== undefined ? { before: operation.before } : {}),
      ...(operation.after !== undefined ? { after: operation.after } : {}),
      reason: operation.reason,
    })),
    warnings: verification.warnings.map((warning) => warning.message),
    ...(verification.error ? { error: verification.error } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.needsConfirmation ? { needsConfirmation: true } : {}),
  }
}
