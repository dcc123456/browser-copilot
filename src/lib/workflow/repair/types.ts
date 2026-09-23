/**
 * Unified repair domain types (spec §5).
 *
 * These types are the shared vocabulary between the generation agent and the
 * AI-debug agent: execution traces, failure analysis, variable provenance,
 * patch sets and verification results. They live in `lib` (pure, no browser or
 * provider dependency) so both the background orchestration and tests use the
 * exact same shapes.
 *
 * @module lib/workflow/repair/types
 */

import type { Workflow } from '../types'

/**
 * Why a run / verification failed — the single shared failure vocabulary.
 *
 * Mapped from the raw executor error text by `failure-classifier`. Both the
 * generation path and the debug path classify through that one function, which
 * is what lets the same workflow + trace produce the same analysis.
 */
export type VerificationFailureType =
  // transient / environment (§6.3)
  | 'PAGE_NOT_READY'
  | 'FRAME_NOT_READY'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'NETWORK_ERROR'
  | 'WAIT_CONDITION_UNMET'
  | 'TIMEOUT'
  // variable / contract (§5.3)
  | 'VARIABLE_MISSING'
  | 'VARIABLE_EMPTY'
  | 'VARIABLE_TYPE_ERROR'
  | 'CONTRACT_VIOLATION'
  | 'PRECONDITION_FAILED'
  | 'POSTCONDITION_FAILED'
  // goal (§5.5)
  | 'GOAL_NOT_ACHIEVED'
  // environment / safety
  | 'WRONG_ORIGIN'
  | 'WRONG_PAGE'
  | 'SIDE_EFFECT_UNSAFE'
  // human required (§6.4 Case F)
  | 'AUTH_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  // structure (§6.2)
  | 'STRUCTURAL_ERROR'
  // generic executor error / cancellation
  | 'ACTION_ERROR'
  | 'CANCELLED'
  | 'UNKNOWN'

export type TraceEntry = 'GENERATION' | 'DEBUG' | 'VERIFY' | 'REPLAY'

/** A trace event: one ordered line of what happened during a run. */
export interface TraceEvent {
  sequence: number
  at: number
  kind: 'tool' | 'status' | 'result' | 'error' | 'info' | 'checkpoint'
  nodeId?: string
  text: string
  /** Workflow nesting for events emitted inside a sub-workflow (P3). */
  workflowPathIndex?: number
}

/** Redacted, stable summary of a variable value (never the raw secret). */
export interface VariableValueSummary {
  exists: boolean
  isEmpty?: boolean
  type?: string
  length?: number
  redacted: boolean
  /** Short stable hash (FNV-1a) when the value is serializable. */
  hash?: string
}

/** Evidence that a node READ a variable at one param path. */
export interface VariableUseEvidence {
  variable: string
  consumerNodeId: string
  paramPath: string
  resolved: boolean
  summary: VariableValueSummary
}

/** Evidence that a node WROTE a variable. */
export interface VariableProductionEvidence {
  variable: string
  producerNodeId: string
  summary: VariableValueSummary
  contract?: VariableContractResult
}

/** Per-node execution record; retries append attempts, never overwrite. */
export interface NodeExecutionTrace {
  nodeId: string
  blockId?: string
  attempt: number
  status: 'running' | 'ok' | 'failed' | 'cancelled' | 'skipped'
  startedAt?: number
  finishedAt?: number
  /**
   * Index into ExecutionTrace.workflowPath for the workflow this node ran in
   * (P3): 0 = root workflow, 1+ = a nested sub-workflow. Absent ⇒ root.
   */
  workflowPathIndex?: number
  inputVariables: VariableUseEvidence[]
  outputVariables: VariableProductionEvidence[]
  error?: TraceFailure
}

export interface TraceCheckpoint {
  checkpointId: string
  stepIndex: number
  nodeId?: string
  status: 'running' | 'ok' | 'failed' | 'cancelled'
  variableSummaries: Record<string, VariableValueSummary>
  pageState?: unknown
  /**
   * Whether the variable snapshot was captured successfully (spec §5.1).
   *
   * `false` when the variable bag could not be deep-copied: the summaries
   * MUST NOT be silently treated as an empty-variable state. Callers planning
   * a checkpoint replay refuse to resume from such a point.
   */
  snapshotAvailable: boolean
  at: number
}

export interface TraceFailure {
  code: VerificationFailureType
  message: string
  nodeId?: string
  retryable: boolean
  source: 'EXECUTOR' | 'CONTRACT' | 'POSTCONDITION' | 'GOAL' | 'STRUCTURE'
}

/** Full execution evidence, aggregated in real time (spec §5.1). */
export interface ExecutionTrace {
  traceId: string
  workflowId: string
  sessionId?: string
  runId: string
  entry: TraceEntry

  startedAt: number
  finishedAt?: number
  outcome: 'ok' | 'failed' | 'cancelled'

  events: TraceEvent[]
  nodeExecutions: NodeExecutionTrace[]
  checkpoints: TraceCheckpoint[]

  finalVariables: Record<string, VariableValueSummary>
  failedNodeId?: string
  failure?: TraceFailure

  /**
   * Ordered workflow nesting for this trace (P3, spec §15 Phase 8): the root
   * workflow id first, then each nested sub-workflow entered via
   * `execute-workflow`. Every node execution records the index into this path
   * it ran in, so a failure inside a child can be attributed across the chain.
   */
  workflowPath?: string[]

  currentUrl?: string
  currentTabId?: number
  currentFramePath?: string[]
}

// --- Variable provenance & data flow (§5.2) --------------------------------

export interface VariableProvenance {
  variable: string
  producerNodeId?: string
  producerKind:
    'WORKFLOW_INPUT' | 'NODE_OUTPUT' | 'ENGINE_ALIAS' | 'TRANSFORM' | 'LOOP_CONTEXT' | 'UNKNOWN'
  sourcePath?: string
  sourceVariable?: string
}

export interface DataDependencyEdge {
  fromNodeId?: string
  variable: string
  toNodeId: string
  relation: 'PRODUCES' | 'CONSUMES' | 'TRANSFORMS' | 'CONTROL_DEPENDENCY'
}

export interface DataFlowGraph {
  producers: Map<string, VariableProvenance[]>
  consumers: Map<string, VariableUseEvidence[]>
  edges: DataDependencyEdge[]
}

// --- Variable contract (§5.3) ----------------------------------------------

export interface VariableContract {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  allowEmpty?: boolean
  minLength?: number
  pattern?: string
}

export interface VariableContractResult {
  valid: boolean
  violations: string[]
}

// --- Failure analysis (§5.4) -----------------------------------------------

export interface DependencyNode {
  nodeId?: string
  variable?: string
  relation: 'USES_VARIABLE' | 'PRODUCES_VARIABLE' | 'TRANSFORMS_VARIABLE' | 'CONTROL_DEPENDENCY'
}

/** Variable-level evidence row attached to a failure analysis. */
export interface VariableEvidence {
  evidenceId: string
  variable: string
  nodeId?: string
  kind: 'PRODUCED' | 'CONSUMED' | 'TRANSFORMED' | 'MISSING' | 'EMPTY' | 'TYPE'
  summary: VariableValueSummary
  contract?: VariableContractResult
  detail: string
}

/** Page/locator evidence row attached to a failure analysis. */
export interface PageEvidence {
  evidenceId: string
  nodeId?: string
  kind: 'URL' | 'SELECTOR' | 'LOCATOR' | 'DOM' | 'FRAME'
  detail: string
}

export interface RootCauseCandidate {
  nodeId: string
  reason: string
  confidence: number
  evidenceIds: string[]
}

export interface FailureAnalysis {
  analysisVersion: 1
  analysisId: string
  failedNodeId: string
  rootCauseNodeIds: string[]
  failureType: VerificationFailureType

  repairTarget: 'FAILED_NODE' | 'UPSTREAM_NODE' | 'MULTIPLE_NODES' | 'NO_SAFE_REPAIR'

  dependencyChain: DependencyNode[]
  variableEvidence: VariableEvidence[]
  pageEvidence: PageEvidence[]
  alternatives: RootCauseCandidate[]

  explanation: string
  confidence: number
  retryRecommended: boolean
  replayFromNodeId?: string
}

// --- Verification (§5.5) ---------------------------------------------------

export interface VerificationWarning {
  code: VerificationFailureType | string
  message: string
  nodeId?: string
}

export interface VerificationResult {
  success: boolean
  verified: boolean
  goalAchieved?: boolean

  trace: ExecutionTrace
  failedNodeId?: string
  failureType?: VerificationFailureType
  error?: string

  executedNodes: string[]
  skippedNodes: string[]
  warnings: VerificationWarning[]

  checkpointId?: string
  usedAiTakeover: boolean
  usedFallbackReplay: boolean
}

// --- Patch (§5.6) -----------------------------------------------------------

export interface WorkflowPatchOperation {
  operationId: string
  nodeId: string
  kind:
    | 'SET_PARAM'
    | 'REMOVE_PARAM'
    | 'REPLACE_TARGET'
    | 'REPLACE_INPUT_REF'
    | 'REPLACE_OUTPUT'
    | 'INSERT_NODE'
    | 'REMOVE_NODE'
    | 'REWIRE_EDGE'
  path?: string
  before?: unknown
  after?: unknown
  reason: string
  evidenceIds: string[]
}

export interface WorkflowPatchSet {
  patchSetId: string
  analysisId: string
  operations: WorkflowPatchOperation[]
  reason: string
  confidence: number
  expectedEffect: string
  replayFromNodeId?: string
}

export interface PatchIssue {
  code: string
  message: string
  operationId?: string
}

export interface PatchValidationResult {
  ok: boolean
  issues: PatchIssue[]
  /** Changed node ids when validation produced a diff on a clone. */
  changedNodeIds: string[]
}

export interface PatchApplyResult {
  workflow: Workflow
  changedNodeIds: string[]
}

// --- Repair session / policy (§11, §13) ------------------------------------

export interface RepairPolicy {
  maxVerifyRounds: number
  maxRepairRounds: number
  maxRepairPerNode: number
  maxSameFailureSignature: number
  maxTransientRetries: number
  maxProbePerNode: number
  maxTotalDurationMs: number
  allowWholeWorkflowRewrite: boolean
  /**
   * Confidence below which a repair is NOT applied automatically (P2, spec
   * §6.5/§17.2). When both the diagnosis and the proposed patch are below this
   * threshold the engine returns the proposal for explicit human confirmation
   * instead of mutating a working copy.
   */
  autoApplyConfidenceThreshold: number
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  maxVerifyRounds: 6,
  maxRepairRounds: 5,
  maxRepairPerNode: 2,
  maxSameFailureSignature: 2,
  maxTransientRetries: 2,
  maxProbePerNode: 1,
  maxTotalDurationMs: 120_000,
  allowWholeWorkflowRewrite: true,
  autoApplyConfidenceThreshold: 0.75,
}

export type RepairSessionStatus =
  | 'EXECUTING'
  | 'ANALYZING'
  | 'DIAGNOSED'
  | 'PATCH_PROPOSED'
  | 'PATCHING'
  | 'REPLAYING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'DRAFT'
  | 'FAILED'
  | 'CANCELLED'

export interface RepairRoundSummary {
  round: number
  failedNodeId?: string
  rootCauseNodeIds: string[]
  failureType?: VerificationFailureType
  patchSetId?: string
  result: 'VERIFIED' | 'TRANSIENT_RECOVERY' | 'FAILED' | 'DRAFT' | 'CANCELLED'
}

export interface RepairContext {
  failedNodeId: string
  rootCauseNodeIds: string[]
  failureType: VerificationFailureType
  dependencyChain: DependencyNode[]
  variableEvidence: VariableEvidence[]
  pageEvidence: PageEvidence[]
  allowedNodeIds: string[]
  allowedParamPaths: Record<string, string[]>
  recentTrace: TraceEvent[]
  repairHistory: RepairRoundSummary[]
}

export interface WorkflowRepairSession {
  sessionId: string
  workflowId: string
  entry: 'GENERATION' | 'DEBUG'
  status: RepairSessionStatus

  originalWorkflow: Workflow
  workingCopy: Workflow

  rounds: RepairRoundSummary[]
  pendingPatch?: WorkflowPatchSet
  lastVerification?: VerificationResult
  lastAnalysis?: FailureAnalysis

  policy: RepairPolicy
  createdAt: number
  updatedAt: number
}

/** Replay side-effect classification (§9.3). */
export type ReplaySafety =
  'SAFE' | 'IDEMPOTENT' | 'REQUIRES_STATE_CHECK' | 'REQUIRES_CONFIRMATION' | 'FORBIDDEN_AUTO_REPLAY'

export interface ReplayOptions {
  allowAiTakeover?: boolean
  /** Force a full replay instead of a checkpoint resume. */
  full?: boolean
  signal?: AbortSignal
}

export interface VerificationOptions {
  entry?: TraceEntry
  allowAiTakeover?: boolean
  signal?: AbortSignal
  variables?: Record<string, unknown>
}
