/**
 * Repair proposal — user-understandable, confirmable view over a patch set
 * (spec §12 · Commit 12).
 *
 * Turns a raw {@link WorkflowPatchSet} into a structured proposal the Failure
 * Center renders per node:
 *
 * ```text
 * Before · After · Reason · Evidence · Risk · Verification Plan · Affected Nodes
 * ```
 *
 * Risk is derived DETERMINISTICALLY from the change shape, never copied from
 * the model's self-assessment:
 *
 *   - HIGH   a node is removed, a whole node inserted, or edges rewired — these
 *            can change control flow;
 *   - MEDIUM a target is replaced (a different element is acted on);
 *   - LOW    a param/value/input reference is changed.
 *
 * The overall proposal risk is the highest per-operation risk. HIGH risk still
 * only enters a working copy after the user confirms (the caller enforces it).
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/repair/repair-proposal
 */

import type {
  WorkflowPatchOperation,
  WorkflowPatchSet,
} from './types'

export type ProposalRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

/** One operation expanded for display. */
export interface ProposalNodeChange {
  operationId: string
  nodeId: string
  kind: WorkflowPatchOperation['kind']
  path?: string
  before?: unknown
  after?: unknown
  reason: string
  evidenceIds: string[]
  risk: ProposalRiskLevel
}

export interface RepairProposalView {
  patchSetId: string
  changes: ProposalNodeChange[]
  /** Overall risk = highest per-operation risk. */
  risk: ProposalRiskLevel
  reason: string
  expectedEffect: string
  /** Affected node ids, de-duplicated. */
  affectedNodeIds: string[]
  /** Observable facts the replay should verify, derived from the changes. */
  verificationPlan: string[]
}

// --- risk derivation --------------------------------------------------------

function riskOfOperation(operation: WorkflowPatchOperation): ProposalRiskLevel {
  switch (operation.kind) {
    case 'REMOVE_NODE':
    case 'INSERT_NODE':
    case 'REWIRE_EDGE':
      return 'HIGH'
    case 'REPLACE_TARGET':
    case 'REPLACE_OUTPUT':
      return 'MEDIUM'
    case 'SET_PARAM':
    case 'REMOVE_PARAM':
    case 'REPLACE_INPUT_REF':
      return 'LOW'
    default:
      return 'MEDIUM'
  }
}

const RISK_RANK: Record<ProposalRiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

function highestRisk(changes: ProposalNodeChange[]): ProposalRiskLevel {
  let highest: ProposalRiskLevel = 'LOW'
  for (const change of changes) {
    if (RISK_RANK[change.risk] > RISK_RANK[highest]) highest = change.risk
  }
  return highest
}

/** Render an evidence id as a neutral line for the evidence list. */
function evidenceLabel(id: string): string {
  return id
}

/** Build an observable verification step for a change. */
function verificationStepOf(change: ProposalNodeChange): string {
  switch (change.kind) {
    case 'SET_PARAM':
      return `replay and observe ${change.nodeId}${change.path ? `.${change.path}` : ''}`
    case 'REPLACE_TARGET':
      return `replay from ${change.nodeId} and confirm the new target resolves to one element`
    case 'INSERT_NODE':
      return `replay and confirm the inserted step ${change.nodeId} executes`
    case 'REMOVE_NODE':
      return `replay and confirm routing is preserved without ${change.nodeId}`
    case 'REWIRE_EDGE':
      return `replay and confirm the changed edge routes as expected around ${change.nodeId}`
    default:
      return `replay and verify ${change.nodeId}`
  }
}

/** Expand a patch set into a confirmable proposal view. */
export function buildRepairProposal(patch: WorkflowPatchSet): RepairProposalView {
  const changes: ProposalNodeChange[] = patch.operations.map((operation) => ({
    operationId: operation.operationId,
    nodeId: operation.nodeId,
    kind: operation.kind,
    ...(operation.path ? { path: operation.path } : {}),
    ...(operation.before !== undefined ? { before: operation.before } : {}),
    ...(operation.after !== undefined ? { after: operation.after } : {}),
    reason: operation.reason,
    evidenceIds: operation.evidenceIds,
    risk: riskOfOperation(operation),
  }))

  const affectedNodeIds = [...new Set(changes.map((change) => change.nodeId))]

  const verificationPlan = changes.map(verificationStepOf)
  if (patch.expectedEffect) {
    verificationPlan.push(`confirm the overall effect: ${patch.expectedEffect}`)
  }

  return {
    patchSetId: patch.patchSetId,
    changes,
    risk: highestRisk(changes),
    reason: patch.reason,
    expectedEffect: patch.expectedEffect,
    affectedNodeIds,
    verificationPlan,
  }
}

/** All evidence ids cited across a proposal, de-duplicated. */
export function evidenceOfProposal(proposal: RepairProposalView): string[] {
  const ids = new Set<string>()
  for (const change of proposal.changes) {
    for (const id of change.evidenceIds) ids.add(evidenceLabel(id))
  }
  return [...ids]
}
