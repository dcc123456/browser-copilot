/**
 * Autonomous repair orchestrator (spec §12–§24, Commits 7–14).
 *
 * The full automatic loop that replaces the single-shot "propose once then
 * hand to human" repair:
 *
 * ```text
 * precheck → (diagnose → strategy → candidate → apply → resume → verify)
 *          → pass: commit ai-repair revision
 *          → fail: re-diagnose, next strategy, up to the bounded budget
 *          → only genuine safety/external blockers or an exhausted ladder
 *            become HUMAN_TAKEOVER
 * ```
 *
 * Hard rules enforced here:
 *   - "no patch proposed" (`MODEL_NO_CANDIDATE` / an empty parse) ADVANCES to
 *     the next strategy — it is never, by itself, a human takeover
 *     (spec §21.2, §27.2);
 *   - an invalid candidate gets at most ONE corrective re-ask, then advances;
 *   - candidates apply to a CLONE; the saved workflow is untouched until a
 *     verified result commits;
 *   - resume starts from the clean checkpoint so finished dangerous actions
 *     are not re-driven;
 *   - only an L3 (goal) pass commits; everything else rolls the clone back.
 *
 * Every phase emits a {@link RepairProgressEvent}. Engine primitives are
 * injected (no `chrome` / DOM in this module).
 *
 * @module background/workflow-engine/auto-repair/orchestrator
 */
import {
  applyRepairCandidate,
  parseRepairResponse,
  type RepairCandidate,
} from '../../../lib/workflow/repair-candidate'
import {
  nextStrategyOf,
  strategyUsesModel,
  type NextStrategyResult,
} from '../../../lib/workflow/repair-policy'
import {
  beginAttempt,
  currentAttempt,
  durationBudgetExceeded,
  finishAttempt,
  settleRepair,
  updateCurrentAttempt,
  type FailureSnapshot,
  type RepairAttempt,
  type RepairSession,
  type VerificationResult as SessionVerificationResult,
} from '../../../lib/workflow/repair-session'
import { startRepairSession } from '../../../lib/workflow/repair-session'
import { verifyRepair, type VerificationDeps } from '../../../lib/workflow/repair-verification'
import type { RepairVerificationResult } from '../../../lib/workflow/repair-verification'
import { workflowFingerprintOf } from '../../../lib/workflow/checkpoints'
import type { RepairProgressEvent } from '../../../lib/workflow/repair-events'
import type { Workflow } from '../../../lib/workflow/types'

// Re-export the shared progress event vocabulary (spec §19.2, Commit 14).
export type { RepairProgressEvent } from '../../../lib/workflow/repair-events'

// --- Injected engine primitives ----------------------------------------------

export interface CandidateContext {
  workflow: Workflow
  failure: FailureSnapshot
  strategy: string
  /** Prior model output when this is a corrective re-ask. */
  previousOutput?: unknown
  previousIssues?: string[]
}

export interface ResumeResult {
  outcome: 'passed' | 'failed' | 'cancelled'
  error?: string
  failedNodeId?: string
}

export interface AutoRepairDeps {
  /**
   * Ask the model for a candidate under the given strategy. The raw return is
   * parsed by the orchestrator.
   */
  produceCandidate: (context: CandidateContext) => Promise<unknown>
  /** Deterministic readiness recovery (S1): wait / scroll / focus / retry. */
  attemptReadinessRecovery: (
    workflow: Workflow,
    failure: FailureSnapshot,
  ) => Promise<{ ok: boolean; note?: string; candidate?: RepairCandidate }>
  /**
   * Resume the workflow from the clean checkpoint (or the given start node).
   * `variables` carry the checkpoint snapshot.
   */
  resumeRun: (
    workflow: Workflow,
    startNodeId: string | undefined,
    variables: Record<string, unknown>,
  ) => Promise<ResumeResult>
  /** Condition/goal evaluator for L2/L3 (live page). */
  verification: VerificationDeps
  /**
   * Persist a verified workflow as an `ai-repair` revision. Returns the new
   * revision number.
   */
  commit: (workflow: Workflow, repairSessionId: string) => Promise<number>
  emit: (event: RepairProgressEvent) => void
}

// --- Session construction -----------------------------------------------------

export interface StartAutoRepairInput {
  workflow: Workflow
  runId: string
  failure: FailureSnapshot
  deps: AutoRepairDeps
  signal?: AbortSignal
}

// --- Helpers ------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return !!error && (error as { name?: string }).name === 'AbortError'
}

function describeParseOutcome(kind: string, issues?: string[], reason?: string): string {
  if (kind === 'empty') return 'no patch proposed'
  if (kind === 'invalid') return `invalid candidate: ${(issues ?? []).join('; ')}`
  return reason ?? 'candidate refused'
}

// --- Main loop ----------------------------------------------------------------

/**
 * Run autonomous repair to a terminal result:
 * `success` (committed), `blocked` (genuine human gate) or `exhausted`.
 */
export async function runAutoRepair(input: StartAutoRepairInput): Promise<RepairSession> {
  const { workflow, runId, failure, deps, signal } = input
  const fingerprint = workflowFingerprintOf(workflow)
  let session: RepairSession = startRepairSession({
    workflowId: workflow.id,
    runId,
    failedNodeId: failure.nodeId,
    fingerprint,
    failure,
  })

  deps.emit({ type: 'repair.started', sessionId: session.id, workflowId: workflow.id, runId })

  // The workflow currently under test. Starts as the original; candidate
  // applications replace it (a clone), and a failed verify discards it.
  let candidateWorkflow: Workflow = workflow

  try {
    // S0 precheck: is the goal already satisfied? Runs before any candidate.
    const ladderFirst = nextStrategyOf({
      failureType: failure.errorType,
      attempts: session.attempts,
      budget: session.budget,
      modelCalls: session.modelCalls,
      startedAt: session.startedAt,
    })

    if (ladderFirst.kind === 'blocked') {
      deps.emit({ type: 'repair.blocked', sessionId: session.id, reason: ladderFirst.reason })
      return settleRepair(session, {
        status: 'blocked',
        reason: ladderFirst.reason,
        attempts: session.attempts.length,
        durationMs: Date.now() - session.startedAt,
        committed: false,
      })
    }

    // The ladder walk.
    let next: NextStrategyResult = ladderFirst

    while (next.kind === 'next') {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const strategy = next.strategy

      session = beginAttempt(session, strategy)
      const attemptNumber = session.attempts.length
      deps.emit({
        type: 'repair.diagnosing',
        sessionId: session.id,
        strategy,
        attempt: attemptNumber,
      })

      // --- Obtain a candidate for this strategy ---
      let candidate: RepairCandidate | undefined

      if (strategy === 'terminal-state-check') {
        // S0: verify goal without acting. verifyRepair short-circuits.
        const noopCandidate: RepairCandidate = {
          strategy,
          reason: 'terminal state check',
          nodePatches: [],
          edgePatches: [],
          expectedPostconditions: [],
        }
        const already = await verifyRepair(workflow, noopCandidate, true, deps.verification)
        if (already.passed && already.alreadySatisfied) {
          // Goal already holds — nothing to repair; report success without a
          // revision (the workflow is correct as saved).
          session = finishAttempt(session, { verification: toSessionVerification(already) }, 'verified')
          deps.emit({ type: 'repair.verifying', sessionId: session.id })
          deps.emit({ type: 'repair.success', sessionId: session.id, note: already.note })
          return settleRepair(session, {
            status: 'success',
            strategy,
            reason: already.note,
            attempts: session.attempts.length,
            durationMs: Date.now() - session.startedAt,
            committed: false,
          })
        }
        // Not already satisfied — S0 produced no candidate; advance.
        session = finishAttempt(session, {}, 'no-candidate')
        next = nextStrategyOf({
          failureType: failure.errorType,
          attempts: session.attempts,
          budget: session.budget,
          modelCalls: session.modelCalls,
          startedAt: session.startedAt,
        })
        continue
      }

      if (strategy === 'readiness-recovery') {
        // S1: deterministic wait / scroll / focus / retry.
        const readiness = await deps.attemptReadinessRecovery(workflow, failure)
        if (readiness.ok && readiness.candidate) {
          candidate = readiness.candidate
        } else if (readiness.ok) {
          // Readiness action claims recovery; verify without a graph change.
          candidate = {
            strategy,
            reason: readiness.note ?? 'readiness recovery',
            nodePatches: [],
            edgePatches: [],
            expectedPostconditions: [],
          }
        } else {
          session = finishAttempt(session, {}, 'no-candidate')
          deps.emit({ type: 'repair.attempt-failed', sessionId: session.id, attempt: attemptNumber, reason: 'readiness recovery failed' })
          next = advance(session, failure)
          continue
        }
      } else {
        // Model-driven strategy (S2–S7).
        const raw = await deps.produceCandidate({
          workflow: candidateWorkflow,
          failure,
          strategy,
        })
        if (strategyUsesModel(strategy)) session = bumpModelCalls(session)

        let parsed = parseRepairResponse(raw)

        if (parsed.kind === 'invalid') {
          // One corrective re-ask (spec §27.3).
          session = updateCurrentAttempt(session, {})
          const corrected = await deps.produceCandidate({
            workflow: candidateWorkflow,
            failure,
            strategy,
            previousOutput: raw,
            previousIssues: parsed.issues,
          })
          if (strategyUsesModel(strategy)) session = bumpModelCalls(session)
          parsed = parseRepairResponse(corrected)
        }

        if (parsed.kind === 'empty' || parsed.kind === 'refusal') {
          // CRITICAL (spec §27.2): no candidate from THIS strategy advances
          // to the next one — it never escalates directly to human.
          session = finishAttempt(
            session,
            {
              diagnosis: {
                type: 'MODEL_NO_CANDIDATE',
                rootCauseNodeIds: [failure.nodeId],
                explanation: describeParseOutcome(parsed.kind, undefined, parsed.kind === 'refusal' ? parsed.reason : undefined),
                confidence: 0,
              },
            },
            'no-candidate',
          )
          deps.emit({
            type: 'repair.attempt-failed',
            sessionId: session.id,
            attempt: attemptNumber,
            reason: describeParseOutcome(parsed.kind, undefined, parsed.kind === 'refusal' ? parsed.reason : undefined),
          })
          next = advance(session, failure)
          continue
        }

        if (parsed.kind === 'invalid') {
          session = finishAttempt(
            session,
            {
              diagnosis: {
                type: 'MODEL_OUTPUT_INVALID',
                rootCauseNodeIds: [failure.nodeId],
                explanation: describeParseOutcome('invalid', parsed.issues),
                confidence: 0,
              },
            },
            'invalid-candidate',
          )
          deps.emit({
            type: 'repair.attempt-failed',
            sessionId: session.id,
            attempt: attemptNumber,
            reason: describeParseOutcome('invalid', parsed.issues),
          })
          next = advance(session, failure)
          continue
        }

        candidate = parsed.candidate
      }

      if (!candidate) {
        session = finishAttempt(session, {}, 'no-candidate')
        next = advance(session, failure)
        continue
      }

      // --- Apply to a clone ---
      session = updateCurrentAttempt(session, { candidate })
      const applied = applyRepairCandidate(candidateWorkflow, candidate)
      if (applied.issues.length > 0) {
        // Static integrity failed — roll back the clone.
        session = finishAttempt(
          session,
          {
            applyResult: { changedNodeIds: applied.changedNodeIds, appliedAt: Date.now() },
          },
          'apply-failed',
        )
        deps.emit({
          type: 'repair.attempt-failed',
          sessionId: session.id,
          attempt: attemptNumber,
          reason: `candidate failed static validation: ${applied.issues.join('; ')}`,
        })
        next = advance(session, failure)
        continue
      }
      candidateWorkflow = applied.workflow
      deps.emit({
        type: 'repair.applying',
        sessionId: session.id,
        strategy,
        changedNodeIds: applied.changedNodeIds,
      })

      // --- Resume from the clean checkpoint ---
      const checkpointNode = failure.checkpoint?.nodeId
      const resumeVariables = failure.checkpoint?.variables ?? {}
      deps.emit({ type: 'repair.resuming', sessionId: session.id, nodeId: checkpointNode ?? failure.nodeId })
      const resumed = await deps.resumeRun(candidateWorkflow, checkpointNode, resumeVariables)

      if (resumed.outcome === 'cancelled') {
        throw new DOMException('aborted', 'AbortError')
      }

      // --- Verify (L1 / L2 / L3) ---
      deps.emit({ type: 'repair.verifying', sessionId: session.id })
      const nodeSucceeded = resumed.outcome === 'passed'
      const verification = await verifyRepair(candidateWorkflow, candidate, nodeSucceeded, deps.verification)
      session = updateCurrentAttempt(session, {
        applyResult: { changedNodeIds: applied.changedNodeIds, appliedAt: Date.now() },
      })

      if (verification.passed) {
        session = finishAttempt(session, { verification: toSessionVerification(verification) }, 'verified')

        // Auto-commit the verified workflow as an ai-repair revision.
        const revision = await deps.commit(candidateWorkflow, session.id)
        deps.emit({ type: 'repair.success', sessionId: session.id, revision, note: verification.note })
        return settleRepair(session, {
          status: 'success',
          strategy,
          attempts: session.attempts.length,
          durationMs: Date.now() - session.startedAt,
          committed: true,
        })
      }

      // Verification failed — discard the clone (rollback) and advance.
      candidateWorkflow = workflow
      session = finishAttempt(
        session,
        { verification: toSessionVerification(verification) },
        'verification-failed',
      )
      deps.emit({
        type: 'repair.attempt-failed',
        sessionId: session.id,
        attempt: attemptNumber,
        reason: verification.note ?? 'verification failed',
      })
      next = advance(session, failure)
    }

    // next.kind exhausted/blocked after the walk.
    if (next.kind === 'blocked') {
      deps.emit({ type: 'repair.blocked', sessionId: session.id, reason: next.reason })
      return settleRepair(session, {
        status: 'blocked',
        reason: next.reason,
        attempts: session.attempts.length,
        durationMs: Date.now() - session.startedAt,
        committed: false,
      })
    }

    deps.emit({ type: 'repair.exhausted', sessionId: session.id, reason: next.reason })
    return settleRepair(session, {
      status: 'exhausted',
      reason: next.reason,
      attempts: session.attempts.length,
      durationMs: Date.now() - session.startedAt,
      committed: false,
    })
  } catch (error) {
    if (isAbortError(error)) {
      deps.emit({ type: 'repair.blocked', sessionId: session.id, reason: 'repair cancelled' })
      return settleRepair(session, {
        status: 'blocked',
        reason: 'repair cancelled by the user',
        attempts: session.attempts.length,
        durationMs: Date.now() - session.startedAt,
        committed: false,
      })
    }
    throw error
  }
}

// --- Internal helpers ---------------------------------------------------------

function bumpModelCalls(session: RepairSession): RepairSession {
  return { ...session, modelCalls: session.modelCalls + 1, updatedAt: Date.now() }
}

function advance(session: RepairSession, failure: FailureSnapshot): NextStrategyResult {
  if (durationBudgetExceeded(session)) {
    return { kind: 'exhausted', reason: 'total duration budget exceeded' }
  }
  return nextStrategyOf({
    failureType: failure.errorType,
    attempts: session.attempts,
    budget: session.budget,
    modelCalls: session.modelCalls,
    startedAt: session.startedAt,
  })
}

function toSessionVerification(result: RepairVerificationResult): SessionVerificationResult {
  return {
    passed: result.passed,
    ...(result.alreadySatisfied ? { achievedGoal: true } : {}),
    layers: {
      node: result.layers.node,
      postconditions: result.layers.postconditions,
      goal: result.layers.goal,
      unmetConditions: result.unmet,
      ...(result.note ? { note: result.note } : {}),
    },
    executedNodeIds: [],
  }
}

/** The current attempt outcome (used by adapters/tests). */
export function lastAttemptOutcome(session: RepairSession): RepairAttempt['outcome'] | undefined {
  return currentAttempt(session)?.outcome
}
