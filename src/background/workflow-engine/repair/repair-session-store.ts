/**
 * Background repair session store (spec §10, §11).
 *
 * Holds the AUTO_REPAIR verified WORKING COPY in memory until the user either
 * commits it (formal save) or discards it. The formal saved workflow is never
 * replaced by the repair loop; only {@link commitRepairWorkingCopy} produces
 * the workflow the caller persists.
 *
 * In-memory by design (like running tasks): an unverified repair is not worth
 * durable pending state, and a worker eviction simply drops it. A verified
 * result returns immediately to the panel while the worker is retained for the
 * confirmation, matching the existing debug flow.
 *
 * @module background/workflow-engine/repair/repair-session-store
 */

import type {
  FailureAnalysis,
  VerificationResult,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'

export interface PendingRepairSession {
  workflowId: string
  /** Verified repaired working copy, ready for the formal commit. */
  workingCopy: Workflow
  patch: WorkflowPatchSet
  analysis: FailureAnalysis
  verification: VerificationResult
  /**
   * Formal workflow's `updatedAt` at the moment the repair was produced.
   *
   * Optimistic-lock base (spec §11.3): when the user later commits, the formal
   * workflow is re-read and its `updatedAt` compared to this value. A formal
   * workflow that changed underneath the pending repair means the patch may be
   * stale; the commit is refused and a fresh diagnosis is required.
   */
  baseUpdatedAt: number
  /** Stable content hash of the base workflow, as a second lock signal. */
  baseHash: string
  createdAt: number
}

const sessions = new Map<string, PendingRepairSession>()

/** Persist a verified repair working copy for the given workflow. */
export function putRepairSession(session: PendingRepairSession): void {
  sessions.set(session.workflowId, session)
}

/** The pending verified repair session, if any. */
export function getRepairSession(workflowId: string): PendingRepairSession | undefined {
  return sessions.get(workflowId)
}

/** Remove and return the pending session (used before the formal save). */
export function takeRepairSession(workflowId: string): PendingRepairSession | undefined {
  const session = sessions.get(workflowId)
  if (session) sessions.delete(workflowId)
  return session
}

/** Discard any pending repair session. Returns true when one existed. */
export function discardRepairSession(workflowId: string): boolean {
  return sessions.delete(workflowId)
}

/** Workflow ids with a pending verified repair (used by tests / pending UI). */
export function pendingRepairWorkflowIds(): string[] {
  return [...sessions.keys()].sort()
}
