/**
 * Recovery orchestration — single-entry product repair flow (spec §11 ·
 * Commit 08).
 *
 * Keeps the Unified Debug Engine but adds ONE product entry the UI calls:
 *
 * ```text
 * startAiRepair
 *   DIAGNOSE → PROPOSAL
 *   ⏸ await user confirm repair
 *   APPLY → replay → takeover-free verification
 *   ⏸ await user confirm overwrite
 *   COMMIT
 * ```
 *
 * The UI never references ANALYZE / SUGGEST / AUTO_REPAIR; it only observes
 * the orchestrator phase. Hard rules enforced here:
 *
 *   - at most ONE active repair session at a time (a second start is refused);
 *   - Diagnose and Proposal run automatically, back to back;
 *   - after the proposal the session PAUSES for explicit repair confirmation;
 *   - after verification passes it PAUSES for explicit overwrite confirmation;
 *   - the formal Workflow is never committed without the second confirmation.
 *
 * Engine operations are injected so this module stays free of `chrome` / DOM
 * and is unit-testable; a thin adapter (see `createUnifiedDebugActions`) maps
 * them onto `runUnifiedDebug`.
 *
 * @module background/workflow-engine/recovery-orchestrator
 */

import type { Workflow } from '../../lib/workflow/types'
import type {
  FailureAnalysis,
  VerificationResult,
  WorkflowPatchSet,
} from '../../lib/workflow/repair/types'

// --- phases ----------------------------------------------------------------

export type RecoveryPhase =
  | 'DIAGNOSING'
  | 'PROPOSING'
  | 'AWAIT_REPAIR_CONFIRM'
  | 'APPLYING'
  | 'VERIFYING'
  | 'AWAIT_OVERWRITE_CONFIRM'
  | 'COMMITTING'
  | 'DONE'
  | 'CANCELLED'
  | 'FAILED'
  | 'HUMAN_TAKEOVER'

export type RecoveryStatus = 'running' | 'waiting' | 'done' | 'failed'

export interface RepairProposal {
  patch: WorkflowPatchSet
  summary: string
  /** Whether the proposal was low-confidence and should be flagged. */
  lowConfidence: boolean
}

export interface RecoverySession {
  requestId: string
  runId: string
  workflowId: string
  /** Revision of the workflow under repair (Commit 10 fills this; optional now). */
  workflowRevision?: number
  phase: RecoveryPhase
  status: RecoveryStatus
  workflow: Workflow
  analysis?: FailureAnalysis
  proposal?: RepairProposal
  verification?: VerificationResult
  /** Verified working copy awaiting overwrite confirmation. */
  workingCopy?: Workflow
  reason?: string
  createdAt: number
  updatedAt: number
}

// --- injected engine actions ----------------------------------------------

export interface RecoveryActions {
  /** Run diagnosis over the workflow (Unified Debug ANALYZE). */
  diagnose: (workflow: Workflow) => Promise<{ analysis: FailureAnalysis; verified: boolean }>
  /** Produce a validated proposal (Unified Debug SUGGEST). */
  propose: (
    workflow: Workflow,
  ) => Promise<{ patch?: WorkflowPatchSet; lowConfidence?: boolean; reason?: string }>
  /**
   * Apply the patch to a working copy and verify by replay WITHOUT AI takeover.
   * Returns the verified working copy and verification result.
   */
  applyAndVerify: (
    workflow: Workflow,
    patch: WorkflowPatchSet,
  ) => Promise<{ workingCopy?: Workflow; verification?: VerificationResult; reason?: string }>
  /** Persist the verified workflow (the formal commit). */
  commit: (workflow: Workflow) => Promise<void>
}

export interface StartAiRepairInput {
  requestId: string
  runId: string
  workflow: Workflow
  actions: RecoveryActions
}

// --- session registry ------------------------------------------------------

let activeSession: RecoverySession | null = null

/** The currently active repair session, or null. */
export function getActiveRecoverySession(): RecoverySession | null {
  return activeSession
}

/** Test-only: reset the registry. */
export function resetRecoverySessions(): void {
  activeSession = null
}

function touch(session: RecoverySession, patch: Partial<RecoverySession>): RecoverySession {
  const next = { ...session, ...patch, updatedAt: Date.now() }
  activeSession = next
  return next
}

/**
 * Start the single-entry AI repair flow and automatically run Diagnose →
 * Proposal, then pause awaiting repair confirmation.
 *
 * Refuses when a repair session is already active.
 */
export async function startAiRepair(input: StartAiRepairInput): Promise<RecoverySession> {
  if (activeSession) {
    throw new Error(`a repair session is already active: ${activeSession.requestId}`)
  }

  const now = Date.now()
  let session: RecoverySession = {
    requestId: input.requestId,
    runId: input.runId,
    workflowId: input.workflow.id,
    phase: 'DIAGNOSING',
    status: 'running',
    workflow: input.workflow,
    createdAt: now,
    updatedAt: now,
  }
  activeSession = session

  // 1. Diagnose
  session = touch(session, { phase: 'DIAGNOSING', status: 'running' })
  let diagnosed: { analysis: FailureAnalysis; verified: boolean }
  try {
    diagnosed = await input.actions.diagnose(input.workflow)
  } catch (err) {
    return touch(session, {
      phase: 'FAILED',
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  session = touch(session, { analysis: diagnosed.analysis })

  // Already healthy — nothing to repair.
  if (diagnosed.verified) {
    return touch(session, { phase: 'DONE', status: 'done' })
  }

  // 2. Propose (automatic, immediately after diagnosis).
  session = touch(session, { phase: 'PROPOSING', status: 'running' })
  const proposed = await input.actions.propose(input.workflow)
  if (!proposed.patch) {
    // No automatic patch is available — the user must take over.
    return touch(session, {
      phase: 'HUMAN_TAKEOVER',
      status: 'failed',
      reason: proposed.reason ?? 'no patch proposed',
    })
  }

  const proposal: RepairProposal = {
    patch: proposed.patch,
    summary: summarizeProposal(proposed.patch),
    lowConfidence: Boolean(proposed.lowConfidence),
  }

  // 3. Pause: await explicit user confirmation before applying anything.
  return touch(session, {
    phase: 'AWAIT_REPAIR_CONFIRM',
    status: 'waiting',
    proposal,
  })
}

function assertSession(requestId: string): RecoverySession {
  if (!activeSession) throw new Error('no active repair session')
  if (activeSession.requestId !== requestId) {
    throw new Error(`request ${requestId} does not match active session ${activeSession.requestId}`)
  }
  return activeSession
}

/**
 * Confirm the repair: apply the proposal to a working copy and verify by
 * replay. On success the session PAUSES awaiting overwrite confirmation; the
 * formal workflow is untouched until then.
 */
export async function confirmRepair(
  requestId: string,
  actions: RecoveryActions,
): Promise<RecoverySession> {
  const session = assertSession(requestId)
  if (session.phase !== 'AWAIT_REPAIR_CONFIRM' || !session.proposal) {
    throw new Error(`cannot confirm repair in phase ${session.phase}`)
  }

  touch(session, { phase: 'APPLYING', status: 'running' })
  const result = await actions.applyAndVerify(session.workflow, session.proposal.patch)
  if (!result.workingCopy || !result.verification?.verified) {
    return touch(activeSession!, {
      phase: 'FAILED',
      status: 'failed',
      ...(result.verification ? { verification: result.verification } : {}),
      reason: result.reason ?? 'the patched workflow did not verify on replay',
    })
  }

  // Pause: a verified working copy needs explicit overwrite confirmation.
  return touch(activeSession!, {
    phase: 'AWAIT_OVERWRITE_CONFIRM',
    status: 'waiting',
    workingCopy: result.workingCopy,
    verification: result.verification,
  })
}

/**
 * Confirm the overwrite: commit the verified working copy as the formal
 * workflow. Only reachable after verification has passed and is the second
 * human confirmation. Without this call nothing is committed.
 */
export async function confirmOverwrite(
  requestId: string,
  actions: RecoveryActions,
): Promise<RecoverySession> {
  const session = assertSession(requestId)
  if (session.phase !== 'AWAIT_OVERWRITE_CONFIRM' || !session.workingCopy) {
    throw new Error(`cannot confirm overwrite in phase ${session.phase}`)
  }

  touch(session, { phase: 'COMMITTING', status: 'running' })
  await actions.commit(session.workingCopy)
  return touch(activeSession!, { phase: 'DONE', status: 'done' })
}

/** Cancel an in-progress repair before it is committed. */
export function cancelRepair(requestId: string): RecoverySession {
  const session = assertSession(requestId)
  const next = touch(session, { phase: 'CANCELLED', status: 'done' })
  activeSession = null
  return next
}

function summarizeProposal(patch: WorkflowPatchSet): string {
  const ops = patch.operations ?? []
  return ops.length > 0
    ? `${ops.length} patch operation(s): ${ops.map((op) => op.kind).join(', ')}`
    : patch.reason || 'workflow patch'
}
