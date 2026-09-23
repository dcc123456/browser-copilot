/**
 * Node + root-cause aware failure signature (spec §13).
 *
 * The legacy {@link failureSignature} is only `nodeId::normalizedError`: it
 * cannot tell that the same error text with a different root cause (or after
 * the root cause moved) is a genuinely new situation, and it mis-buckets when
 * the node id is missing. This module builds the richer, stable signature the
 * repair loop must use:
 *
 * ```
 * workflowId
 * nodeId            — the FAILED (symptom) node
 * failureType       — the shared VerificationFailureType
 * normalizedError   — normalized message slice
 * rootCauseNodeIds  — deterministic order
 * relevantVariableNames — deterministic order
 * ```
 *
 * Pure: no browser/provider. The resulting string is comparable across the
 * generation and debug entries (§10.3), so the same workflow + trace produce
 * the same signature and therefore the same repeat-dead-end decision.
 *
 * @module lib/workflow/repair/failure-signature
 */

import type {
  FailureAnalysis,
  VerificationFailureType,
} from './types'

/** Normalize raw error text the same way the legacy signature does. */
export function normalizeFailureError(error: string): string {
  return error
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export interface FailureSignatureInput {
  workflowId: string
  /** Failed (symptom) node; falls back to 'unknown' only when truly absent. */
  nodeId?: string
  failureType: VerificationFailureType
  error: string
  /** Root-cause nodes located for this failure. */
  rootCauseNodeIds?: readonly string[]
  /** Variables relevant to the failure (abnormal inputs / chain variables). */
  relevantVariableNames?: readonly string[]
}

/** One stable field within the signature. Kept explicit for readability. */
function signatureField(key: string, value: string): string {
  return `${key}=${value}`
}

/**
 * Build the stable failure signature.
 *
 * Field ORDER is fixed so two signatures are string-comparable. Lists are
 * de-duplicated and sorted — never Map/insertion order (§5.4 stability).
 */
export function buildFailureSignature(input: FailureSignatureInput): string {
  const rootCauses = [...new Set(input.rootCauseNodeIds ?? [])].sort().join(',')
  const variables = [...new Set(input.relevantVariableNames ?? [])].sort().join(',')
  return [
    signatureField('workflowId', input.workflowId),
    signatureField('nodeId', input.nodeId || 'unknown'),
    signatureField('failureType', input.failureType),
    signatureField('error', normalizeFailureError(input.error)),
    signatureField('rootCauses', rootCauses),
    signatureField('variables', variables),
  ].join('|')
}

/** Relevant variable names for a failure analysis (abnormal evidence + chain). */
export function relevantVariablesOf(analysis: FailureAnalysis): string[] {
  const names = new Set<string>()
  for (const row of analysis.variableEvidence) {
    if (row.kind === 'MISSING' || row.kind === 'EMPTY' || row.kind === 'TYPE') {
      names.add(row.variable)
    }
  }
  for (const node of analysis.dependencyChain) {
    if (node.variable) names.add(node.variable)
  }
  return [...names].sort()
}

/**
 * Build the signature directly from an analysis + the trace failure text.
 */
export function signatureFromAnalysis(
  workflowId: string,
  analysis: FailureAnalysis,
  error: string,
): string {
  return buildFailureSignature({
    workflowId,
    nodeId: analysis.failedNodeId,
    failureType: analysis.failureType,
    error,
    rootCauseNodeIds: analysis.rootCauseNodeIds,
    relevantVariableNames: relevantVariablesOf(analysis),
  })
}

export interface RepeatCounter {
  /** Count prior occurrences of `signature` (not including this one). */
  count(signature: string): number
  /** Record one occurrence of `signature`. */
  record(signature: string): void
}

/** In-memory repeat counter for one repair session. */
export function createRepeatCounter(): RepeatCounter {
  const seen = new Map<string, number>()
  return {
    count(signature) {
      return seen.get(signature) ?? 0
    },
    record(signature) {
      seen.set(signature, (seen.get(signature) ?? 0) + 1)
    },
  }
}

/**
 * Whether `signature` has reached the policy's repeat threshold AFTER this
 * occurrence. The threshold is `maxSameFailureSignature` (spec §13), not a
 * hardcoded constant.
 *
 * @param prior occurrences before this one
 * @returns true when recording this occurrence should be treated as a dead end
 */
export function reachedFailureThreshold(prior: number, threshold: number): boolean {
  // occurrence count after recording = prior + 1; a threshold of e.g. 2 means
  // the SECOND identical failure is already a dead end.
  return prior + 1 >= Math.max(1, threshold)
}
