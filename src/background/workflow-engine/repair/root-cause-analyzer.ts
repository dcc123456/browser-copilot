/**
 * Root cause analyzer (spec §6.4 · Phase 3).
 *
 * The root-cause decision is deterministic and lives inside
 * `failure-analyzer.analyzeFailure`; this module exposes the small pieces the
 * repair engine consumes separately — candidate ranking and the stable
 * canonical form used to prove that generation and debug produce identical
 * analyses (§10.3, Test U).
 *
 * @module background/workflow-engine/repair/root-cause-analyzer
 */

import type { FailureAnalysis, RootCauseCandidate } from '../../../lib/workflow/repair/types'

/**
 * Rank root-cause candidates by confidence, then node id. The analysis is
 * already deterministically ordered; this keeps ranking explicit and tested.
 */
export function rankCandidates(candidates: readonly RootCauseCandidate[]): RootCauseCandidate[] {
  return [...candidates].sort((a, b) =>
    b.confidence === a.confidence ? a.nodeId.localeCompare(b.nodeId) : b.confidence - a.confidence,
  )
}

/**
 * Canonicalize a {@link FailureAnalysis} for cross-entry comparison.
 *
 * Non-deterministic identity fields (`analysisId`) are stripped, and every
 * collection is reduced to a sorted, shape-only form. Two analyses built from
 * the same workflow + trace must canonicalize identically regardless of
 * whether the entry was GENERATION or DEBUG.
 */
export function canonicalizeAnalysis(analysis: FailureAnalysis): Record<string, unknown> {
  return {
    analysisVersion: analysis.analysisVersion,
    failedNodeId: analysis.failedNodeId,
    rootCauseNodeIds: [...analysis.rootCauseNodeIds].sort(),
    failureType: analysis.failureType,
    repairTarget: analysis.repairTarget,
    dependencyChain: [...analysis.dependencyChain]
      .map((node) => ({
        ...(node.nodeId ? { nodeId: node.nodeId } : {}),
        ...(node.variable ? { variable: node.variable } : {}),
        relation: node.relation,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    variableEvidence: [...analysis.variableEvidence]
      .map((row) => ({
        variable: row.variable,
        nodeId: row.nodeId ?? '',
        kind: row.kind,
        detail: row.detail,
        summary: row.summary,
      }))
      .sort((a, b) =>
        a.variable === b.variable
          ? a.nodeId.localeCompare(b.nodeId)
          : a.variable.localeCompare(b.variable),
      ),
    pageEvidence: [...analysis.pageEvidence]
      .map((row) => ({ nodeId: row.nodeId ?? '', kind: row.kind, detail: row.detail }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    alternatives: rankCandidates(analysis.alternatives).map((candidate) => ({
      nodeId: candidate.nodeId,
      reason: candidate.reason,
      confidence: candidate.confidence,
      evidenceIds: [...candidate.evidenceIds].sort(),
    })),
    explanation: analysis.explanation,
    confidence: analysis.confidence,
    retryRecommended: analysis.retryRecommended,
    replayFromNodeId: analysis.replayFromNodeId ?? '',
  }
}

/** True when two analyses are semantically identical (spec §10.3). */
export function sameAnalysis(a: FailureAnalysis, b: FailureAnalysis): boolean {
  return JSON.stringify(canonicalizeAnalysis(a)) === JSON.stringify(canonicalizeAnalysis(b))
}
