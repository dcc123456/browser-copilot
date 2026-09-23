/**
 * Recovery protocol guards and shared phase types (spec §11 · Commit 10).
 *
 * Sits beside the message schema and provides the two guarantees the protocol
 * promises:
 *
 *   - de-duplication — a repeated action for the SAME in-flight request is a
 *     no-op, so a double-click cannot submit two patches;
 *   - staleness      — a response is dropped when its request id or workflow
 *     revision no longer matches what the client last sent.
 *
 * Pure module: no `chrome`, no timers beyond an injected clock.
 *
 * @module lib/workflow/recovery-protocol
 */

/** Mirrors the orchestrator phases at the protocol boundary. */
export type RecoveryPhaseState =
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

export type RecoveryProtocolStatus = 'running' | 'waiting' | 'done' | 'failed'

/** One in-flight or completed recovery request keyed by request id. */
export interface RecoveryRequestRecord {
  requestId: string
  workflowId: string
  /** Revision the client based the request on. */
  workflowRevision?: number
  /** Actions already accepted for this request (de-dupe set). */
  acceptedActions: string[]
}

let requestCounter = 0

/** Generate a unique recovery request id for a workflow. */
export function newRecoveryRequestId(workflowId: string): string {
  requestCounter += 1
  // Deterministic shape; counter + id keeps it unique within the session and
  // traceable in logs without exposing anything sensitive.
  return `rec-${workflowId}-${Date.now().toString(36)}-${requestCounter}`
}

/**
 * Whether an action may proceed for a request. The FIRST occurrence of an
 * action is accepted; an identical repeat (a double-click) is refused.
 */
export function shouldAcceptRecoveryAction(
  record: RecoveryRequestRecord,
  action: string,
): boolean {
  if (record.acceptedActions.includes(action)) return false
  record.acceptedActions.push(action)
  return true
}

/**
 * Whether a response still matches the request the client cares about. A
 * different request id or an older workflow revision is stale and must be
 * dropped.
 */
export function recoveryResponseIsCurrent(input: {
  responseRequestId: string
  responseRevision?: number
  expectedRequestId: string
  expectedRevision?: number
}): boolean {
  if (input.responseRequestId !== input.expectedRequestId) return false
  // When revisions are tracked, an older/unknown revision is stale.
  if (typeof input.expectedRevision === 'number') {
    if (typeof input.responseRevision !== 'number') return false
    if (input.responseRevision < input.expectedRevision) return false
  }
  return true
}

/** Create an empty request record. */
export function makeRecoveryRequestRecord(input: {
  requestId: string
  workflowId: string
  workflowRevision?: number
}): RecoveryRequestRecord {
  return {
    requestId: input.requestId,
    workflowId: input.workflowId,
    ...(typeof input.workflowRevision === 'number'
      ? { workflowRevision: input.workflowRevision }
      : {}),
    acceptedActions: [],
  }
}
