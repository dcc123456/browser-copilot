/**
 * Repair session state (spec §13, §14, §22).
 *
 * The autonomous repair lifecycle as a serializable state object:
 *
 * ```text
 * precheck → diagnosing → planning → candidate → applying → resuming
 *          → verifying → committing → success
 * ```
 *
 * A verification failure loops back to `diagnosing`/`planning` with the next
 * strategy; only when every strategy is exhausted (`exhausted`) or a genuine
 * external / safety blocker exists (`blocked`) does the UI show a human
 * takeover. The budget bounds the loop (spec §22).
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/repair-session
 */
import type { RunCheckpoint } from './checkpoints'
import type { FailureMemoryEntry } from './failure-memory'
import type { WorkflowFailureType } from './failure-classification'

// --- Phases (spec §13.1) ------------------------------------------------------

export type RepairPhase =
  | 'precheck'
  | 'diagnosing'
  | 'planning'
  | 'candidate'
  | 'applying'
  | 'resuming'
  | 'verifying'
  | 'committing'
  | 'success'
  | 'exhausted'
  | 'blocked'

// --- Strategies (spec §15) ----------------------------------------------------

/**
 * The repair strategy ladder. Order is fixed and meaningful; the policy
 * (repair-policy.ts) walks it in this order.
 */
export type RepairStrategy =
  | 'terminal-state-check'
  | 'readiness-recovery'
  | 'locator-repair'
  | 'parameter-repair'
  | 'local-graph-repair'
  | 'section-replan'
  | 'full-workflow-replan'
  | 'agent-rescue'

export const REPAIR_STRATEGIES: readonly RepairStrategy[] = [
  'terminal-state-check',
  'readiness-recovery',
  'locator-repair',
  'parameter-repair',
  'local-graph-repair',
  'section-replan',
  'full-workflow-replan',
  'agent-rescue',
]

// --- Failure snapshot (spec §14.1) -------------------------------------------

export interface FailureSnapshotPage {
  url?: string
  title?: string
}

export interface FailureSnapshot {
  nodeId: string
  blockId: string
  errorType: WorkflowFailureType
  errorMessage: string

  intent?: string

  page: FailureSnapshotPage

  locator?: unknown
  candidateElements?: unknown[]

  screenshotRef?: string
  pageSnapshot?: string

  previousNode?: {
    nodeId: string
    result?: unknown
  }

  checkpoint?: RunCheckpoint

  failureMemory?: FailureMemoryEntry[]
}

// --- Diagnosis / plan / candidate / apply / verification records --------------

export interface RepairDiagnosis {
  type: WorkflowFailureType
  rootCauseNodeIds: string[]
  explanation: string
  confidence: number
}

export interface RepairPlan {
  strategy: RepairStrategy
  steps: string[]
  scopeNodeIds: string[]
}

export interface RepairApplyResult {
  changedNodeIds: string[]
  appliedAt: number
}

export interface RepairVerificationLayer {
  /** L1 node operation returned success. */
  node: boolean
  /** L2 postconditions held. */
  postconditions: boolean
  /** L3 goal spec satisfied. */
  goal: boolean
  unmetConditions: string[]
  note?: string
}

export interface VerificationResult {
  passed: boolean
  achievedGoal?: boolean
  layers: RepairVerificationLayer
  executedNodeIds: string[]
}

// --- Attempt (spec §14.2) -----------------------------------------------------

export interface RepairAttempt {
  attempt: number
  strategy: RepairStrategy

  diagnosis?: RepairDiagnosis
  plan?: RepairPlan

  /** Serialized candidate (the candidate contract lives in repair-candidate). */
  candidate?: import('./repair-candidate').RepairCandidate

  applyResult?: RepairApplyResult
  verification?: VerificationResult

  startedAt: number
  finishedAt?: number

  outcome:
    | 'candidate'
    | 'no-candidate'
    | 'invalid-candidate'
    | 'apply-failed'
    | 'verification-failed'
    | 'verified'
}

// --- Budget (spec §22) --------------------------------------------------------

export interface RepairBudget {
  maxAttempts: number
  maxSameFailureSignature: number
  maxStrategyRepeats: number
  maxModelCalls: number
  maxToolRoundsPerAttempt: number
  maxTotalDurationMs: number
}

export const DEFAULT_REPAIR_BUDGET: RepairBudget = {
  maxAttempts: 6,
  maxSameFailureSignature: 2,
  maxStrategyRepeats: 1,
  maxModelCalls: 8,
  maxToolRoundsPerAttempt: 8,
  maxTotalDurationMs: 90_000,
}

// --- Final result -------------------------------------------------------------

export interface RepairFinalResult {
  status: 'success' | 'exhausted' | 'blocked'
  strategy?: RepairStrategy
  reason?: string
  attempts: number
  durationMs: number
  /** True when the fix was auto-committed as a workflow revision. */
  committed: boolean
}

// --- Session ------------------------------------------------------------------

export interface RepairSession {
  id: string
  workflowId: string
  runId: string
  failedNodeId: string
  /** Agent debug session id when the repair was launched from workflows.debug. */
  sessionId?: string

  phase: RepairPhase

  originalWorkflowFingerprint: string
  currentWorkflowFingerprint: string

  failure: FailureSnapshot
  attempts: RepairAttempt[]

  startedAt: number
  updatedAt: number

  budget: RepairBudget

  /** Model/tool spend so far. */
  modelCalls: number
  toolRounds: number

  /** Set on `blocked`; machine-readable blocker. */
  blockerReason?: string

  final?: RepairFinalResult
}

// --- Construction / transitions ----------------------------------------------

let repairCounter = 0
function newRepairId(): string {
  repairCounter = (repairCounter + 1) % Number.MAX_SAFE_INTEGER
  return `repair-${Date.now().toString(36)}-${repairCounter.toString(36)}`
}

export interface StartRepairInput {
  workflowId: string
  runId: string
  failedNodeId: string
  fingerprint: string
  failure: FailureSnapshot
  budget?: RepairBudget
  sessionId?: string
  id?: string
  startedAt?: number
}

/** Create a session in `precheck`. */
export function startRepairSession(input: StartRepairInput): RepairSession {
  const now = input.startedAt ?? Date.now()
  return {
    id: input.id ?? newRepairId(),
    workflowId: input.workflowId,
    runId: input.runId,
    failedNodeId: input.failedNodeId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    phase: 'precheck',
    originalWorkflowFingerprint: input.fingerprint,
    currentWorkflowFingerprint: input.fingerprint,
    failure: input.failure,
    attempts: [],
    startedAt: now,
    updatedAt: now,
    budget: input.budget ?? DEFAULT_REPAIR_BUDGET,
    modelCalls: 0,
    toolRounds: 0,
  }
}

/** Move to a phase (no ordering guard — the orchestrator drives the machine). */
export function setRepairPhase(
  session: RepairSession,
  phase: RepairPhase,
  patch?: Partial<RepairSession>,
): RepairSession {
  return { ...session, ...patch, phase, updatedAt: Date.now() }
}

// --- Attempt management -------------------------------------------------------

/** Begin a new attempt for `strategy` (phase planning). */
export function beginAttempt(
  session: RepairSession,
  strategy: RepairStrategy,
): RepairSession {
  const attempt: RepairAttempt = {
    attempt: session.attempts.length + 1,
    strategy,
    startedAt: Date.now(),
    outcome: 'candidate',
  }
  return {
    ...session,
    attempts: [...session.attempts, attempt],
    phase: 'planning',
    updatedAt: Date.now(),
  }
}

const OUTCOME_PHASE: Partial<Record<RepairAttempt['outcome'], RepairPhase>> = {
  candidate: 'candidate',
  'no-candidate': 'diagnosing',
  'invalid-candidate': 'diagnosing',
  'apply-failed': 'diagnosing',
  'verification-failed': 'diagnosing',
  verified: 'committing',
}

/** Finish the current attempt with an outcome and move phase accordingly. */
export function finishAttempt(
  session: RepairSession,
  patch: Partial<Omit<RepairAttempt, 'attempt' | 'strategy' | 'startedAt'>>,
  outcome: RepairAttempt['outcome'],
): RepairSession {
  const last = session.attempts.at(-1)
  if (!last) throw new Error('no active repair attempt')
  const finished: RepairAttempt = {
    ...last,
    ...patch,
    outcome,
    finishedAt: Date.now(),
  }
  const attempts = [...session.attempts.slice(0, -1), finished]
  return {
    ...session,
    attempts,
    phase: OUTCOME_PHASE[outcome] ?? session.phase,
    updatedAt: Date.now(),
  }
}

/** Mutate the current in-flight attempt before it finishes. */
export function updateCurrentAttempt(
  session: RepairSession,
  patch: Partial<RepairAttempt>,
): RepairSession {
  const last = session.attempts.at(-1)
  if (!last) return session
  const updated: RepairAttempt = { ...last, ...patch }
  return {
    ...session,
    attempts: [...session.attempts.slice(0, -1), updated],
    updatedAt: Date.now(),
  }
}

// --- Selectors ----------------------------------------------------------------

/** The current (last) attempt, if any. */
export function currentAttempt(session: RepairSession): RepairAttempt | undefined {
  return session.attempts.at(-1)
}

/** Strategies already attempted. */
export function attemptedStrategies(session: RepairSession): RepairStrategy[] {
  return session.attempts.map((attempt) => attempt.strategy)
}

/** Failure signatures seen, in order. */
export function failureSignatures(session: RepairSession): string[] {
  return session.attempts.map(
    (attempt) =>
      `${attempt.strategy}|${attempt.diagnosis?.type ?? ''}|${attempt.verification?.layers.note ?? ''}`,
  )
}

/** Whether the total-duration budget has been exceeded. */
export function durationBudgetExceeded(session: RepairSession, now = Date.now()): boolean {
  return now - session.startedAt >= session.budget.maxTotalDurationMs
}

/** Settle the session with a final result. */
export function settleRepair(
  session: RepairSession,
  final: RepairFinalResult,
): RepairSession {
  const phase: RepairPhase =
    final.status === 'success' ? 'success' : final.status === 'blocked' ? 'blocked' : 'exhausted'
  return {
    ...session,
    phase,
    final,
    blockerReason: final.status === 'blocked' ? final.reason : session.blockerReason,
    updatedAt: Date.now(),
  }
}
