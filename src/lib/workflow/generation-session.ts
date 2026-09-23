/**
 * Workflow generation session (spec §4, §5, §11).
 *
 * The generation lifecycle as a BACKGROUND-OWNED state machine instead of a
 * React state in `ChatTab`. The panel renders a portal dialog that subscribes
 * to session events; closing (unmounting) the dialog never cancels the
 * generation — only an explicit {@link WorkflowGenerationSession.cancel} does.
 *
 * State machine (spec §4):
 *
 * ```text
 * starting → understanding → executing → compiling → hardening
 *          → ready-to-save → saving → saved
 * ```
 *
 * Every phase transition emits a {@link WorkflowGenerationEvent}; the session
 * object ({@link WorkflowGenerationSession}) is the durable, serializable
 * snapshot. Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/generation-session
 */
import type { WorkflowCondition } from './conditions'
import type { Target } from '../ops'
import type { Workflow, WorkflowNode } from './types'
import type { WorkflowGoalSpec } from './reliability'

// --- Phases -------------------------------------------------------------------

export type WorkflowGenerationPhase =
  | 'starting'
  | 'understanding'
  | 'executing'
  | 'compiling'
  | 'hardening'
  | 'ready-to-save'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'cancelled'

/** Phases in which the generation is still doing background work. */
const ACTIVE_PHASES: ReadonlySet<WorkflowGenerationPhase> = new Set<WorkflowGenerationPhase>([
  'starting',
  'understanding',
  'executing',
  'compiling',
  'hardening',
])

/** Whether a phase transition is allowed (spec §4 ordering). */
const PHASE_ORDER: Record<WorkflowGenerationPhase, number> = {
  starting: 0,
  understanding: 1,
  executing: 2,
  compiling: 3,
  hardening: 4,
  'ready-to-save': 5,
  saving: 6,
  saved: 7,
  failed: 8,
  cancelled: 8,
}

// --- Trace / observation / failure records ------------------------------------

export interface GenerationActionPage {
  url?: string
  title?: string
}

export interface GenerationActionVerification {
  kind: 'action' | 'navigation' | 'read' | 'goal'
  passed: boolean
  evidence?: string
}

/** One action attempt recorded during live execution (spec §5.2). */
export interface GenerationActionTrace {
  index: number
  nodeId: string
  blockId: string
  intent: string

  page: GenerationActionPage

  target?: Target
  params: Record<string, unknown>

  startedAt: number
  completedAt?: number

  result: 'success' | 'failed'

  verification?: GenerationActionVerification
}

/** A page observation the agent made (snapshot / read / inspection). */
export interface GenerationObservation {
  at: number
  kind: 'snapshot' | 'read' | 'inspect' | 'goal-check'
  detail: string
  url?: string
}

/** A non-recovered failure and its classification. */
export interface GenerationFailure {
  at: number
  actionIndex?: number
  category: string
  message: string
  recovered: boolean
}

// --- Progress (spec §5.1) -----------------------------------------------------

export interface GenerationProgress {
  stage: 'understanding' | 'working' | 'verifying' | 'building' | 'finishing'
  messageKey: string
  detailKey?: string
  current?: number
  total?: number
}

// --- Hardening result ---------------------------------------------------------

export interface WorkflowHardeningIssue {
  code: string
  message: string
  nodeId?: string
}

export interface WorkflowHardeningResult {
  ok: boolean
  blockers: WorkflowHardeningIssue[]
  warnings: WorkflowHardeningIssue[]
}

// --- Session ------------------------------------------------------------------

export interface WorkflowGenerationSession {
  id: string
  conversationId: string
  workflowId?: string

  phase: WorkflowGenerationPhase

  userGoal: string
  goalSpec?: WorkflowGoalSpec

  originUrl?: string
  startedAt: number
  updatedAt: number

  actionCount: number
  successfulActionCount: number

  actionTrace: GenerationActionTrace[]
  observations: GenerationObservation[]
  failures: GenerationFailure[]

  workflowCandidate?: Workflow
  hardening?: WorkflowHardeningResult

  progress: GenerationProgress

  /** Set on `failed`; human-readable reason. */
  failureReason?: string
}

// --- Events (spec §11.2) ------------------------------------------------------

export type WorkflowGenerationEvent =
  | { type: 'started'; sessionId: string }
  | {
      type: 'stage'
      sessionId: string
      stage: GenerationProgress['stage']
      messageKey: string
      detailKey?: string
    }
  | { type: 'action-started'; sessionId: string; description: string; intent: string }
  | { type: 'action-completed'; sessionId: string; description: string; passed: boolean }
  | { type: 'recovery'; sessionId: string; description: string }
  | { type: 'goal-check'; sessionId: string; passed: boolean }
  | { type: 'compiling'; sessionId: string }
  | { type: 'hardening'; sessionId: string }
  | { type: 'ready'; sessionId: string; workflowId?: string }
  | { type: 'failed'; sessionId: string; reason: string }
  | { type: 'cancelled'; sessionId: string }

// --- Construction / transitions ----------------------------------------------

let sessionCounter = 0
function newSessionId(): string {
  sessionCounter = (sessionCounter + 1) % Number.MAX_SAFE_INTEGER
  return `gen-${Date.now().toString(36)}-${sessionCounter.toString(36)}`
}

export interface StartGenerationInput {
  conversationId: string
  userGoal: string
  id?: string
  originUrl?: string
  startedAt?: number
}

/** Create a session in the `starting` phase and emit `started`. */
export function startGenerationSession(
  input: StartGenerationInput,
): { session: WorkflowGenerationSession; event: WorkflowGenerationEvent } {
  const now = input.startedAt ?? Date.now()
  const id = input.id ?? newSessionId()
  const session: WorkflowGenerationSession = {
    id,
    conversationId: input.conversationId,
    phase: 'starting',
    userGoal: input.userGoal,
    ...(input.originUrl ? { originUrl: input.originUrl } : {}),
    startedAt: now,
    updatedAt: now,
    actionCount: 0,
    successfulActionCount: 0,
    actionTrace: [],
    observations: [],
    failures: [],
    progress: {
      stage: 'understanding',
      messageKey: 'workflowGenerationUnderstanding',
    },
  }
  return { session, event: { type: 'started', sessionId: id } }
}

function assertTransition(
  session: WorkflowGenerationSession,
  next: WorkflowGenerationPhase,
): void {
  // `failed` / `cancelled` are reachable from any active phase.
  if (next === 'failed' || next === 'cancelled') {
    if (!ACTIVE_PHASES.has(session.phase) && session.phase !== 'ready-to-save' && session.phase !== 'saving') {
      throw new Error(`cannot move a ${session.phase} session to ${next}`)
    }
    return
  }
  if (PHASE_ORDER[next] <= PHASE_ORDER[session.phase]) {
    throw new Error(`invalid generation phase transition: ${session.phase} → ${next}`)
  }
}

export interface TransitionResult {
  session: WorkflowGenerationSession
  events: WorkflowGenerationEvent[]
}

/** Move to a new phase, emitting the corresponding event(s). */
export function transitionGeneration(
  session: WorkflowGenerationSession,
  next: WorkflowGenerationPhase,
  patch?: Partial<WorkflowGenerationSession>,
  reason?: string,
): TransitionResult {
  assertTransition(session, next)
  const now = Date.now()
  const moved: WorkflowGenerationSession = {
    ...session,
    ...patch,
    phase: next,
    updatedAt: now,
    ...(next === 'failed' ? { failureReason: reason ?? session.failureReason } : {}),
  }
  const events: WorkflowGenerationEvent[] = []
  switch (next) {
    case 'understanding':
      events.push({
        type: 'stage',
        sessionId: session.id,
        stage: 'understanding',
        messageKey: 'workflowGenerationUnderstanding',
      })
      break
    case 'compiling':
      events.push({ type: 'compiling', sessionId: session.id })
      events.push({
        type: 'stage',
        sessionId: session.id,
        stage: 'building',
        messageKey: 'workflowGenerationCompiling',
      })
      break
    case 'hardening':
      events.push({ type: 'hardening', sessionId: session.id })
      events.push({
        type: 'stage',
        sessionId: session.id,
        stage: 'finishing',
        messageKey: 'workflowGenerationValidating',
      })
      break
    case 'ready-to-save':
      events.push({
        type: 'ready',
        sessionId: session.id,
        ...(moved.workflowId ? { workflowId: moved.workflowId } : {}),
      })
      break
    case 'failed':
      events.push({
        type: 'failed',
        sessionId: session.id,
        reason: reason ?? moved.failureReason ?? 'generation failed',
      })
      break
    case 'cancelled':
      events.push({ type: 'cancelled', sessionId: session.id })
      break
    default:
      break
  }
  return { session: moved, events }
}

/** Update progress without changing phase. Emits a `stage` event. */
export function updateGenerationProgress(
  session: WorkflowGenerationSession,
  progress: GenerationProgress,
): TransitionResult {
  const moved: WorkflowGenerationSession = {
    ...session,
    progress,
    updatedAt: Date.now(),
  }
  return {
    session: moved,
    events: [
      {
        type: 'stage',
        sessionId: session.id,
        stage: progress.stage,
        messageKey: progress.messageKey,
        ...(progress.detailKey ? { detailKey: progress.detailKey } : {}),
      },
    ],
  }
}

// --- Trace recording ----------------------------------------------------------

export interface RecordActionStartInput {
  blockId: string
  intent: string
  target?: Target
  params?: Record<string, unknown>
  page?: GenerationActionPage
  at?: number
}

/** Record the start of an action during `executing`. Emits `action-started`. */
export function recordActionStarted(
  session: WorkflowGenerationSession,
  input: RecordActionStartInput,
): TransitionResult {
  if (session.phase !== 'executing') {
    throw new Error(`cannot start an action in phase ${session.phase}`)
  }
  const trace: GenerationActionTrace = {
    index: session.actionCount,
    nodeId: '',
    blockId: input.blockId,
    intent: input.intent,
    page: input.page ?? {},
    ...(input.target ? { target: input.target } : {}),
    params: input.params ?? {},
    startedAt: input.at ?? Date.now(),
    result: 'failed',
  }
  const moved: WorkflowGenerationSession = {
    ...session,
    actionCount: session.actionCount + 1,
    actionTrace: [...session.actionTrace, trace],
    updatedAt: Date.now(),
    progress: {
      stage: 'working',
      messageKey: 'workflowGenerationWorking',
      current: session.actionCount + 1,
    },
  }
  return {
    session: moved,
    events: [
      {
        type: 'action-started',
        sessionId: session.id,
        description: input.intent,
        intent: input.intent,
      },
    ],
  }
}

export interface RecordActionFinishInput {
  passed: boolean
  nodeId?: string
  page?: GenerationActionPage
  verification?: GenerationActionVerification
  at?: number
}

/**
 * Finish the in-flight (last) action. Emits `action-completed`. A failed
 * action stays in the trace with `result: 'failed'` and is also folded into
 * `failures`; the compiler later excludes it.
 */
export function recordActionFinished(
  session: WorkflowGenerationSession,
  input: RecordActionFinishInput,
): TransitionResult {
  const last = session.actionTrace.at(-1)
  if (!last || last.completedAt !== undefined) {
    throw new Error('no in-flight action to finish')
  }
  const completedAt = input.at ?? Date.now()
  const finishedTrace: GenerationActionTrace = {
    ...last,
    nodeId: input.nodeId ?? last.nodeId,
    page: { ...last.page, ...(input.page ?? {}) },
    completedAt,
    result: input.passed ? 'success' : 'failed',
    ...(input.verification ? { verification: input.verification } : {}),
  }
  const trace = [...session.actionTrace.slice(0, -1), finishedTrace]
  const failures =
    input.passed
      ? session.failures
      : [
          ...session.failures,
          {
            at: completedAt,
            actionIndex: last.index,
            category: 'action',
            message: input.verification?.evidence ?? last.intent,
            recovered: false,
          },
        ]
  const moved: WorkflowGenerationSession = {
    ...session,
    actionTrace: trace,
    failures,
    ...(input.passed
      ? { successfulActionCount: session.successfulActionCount + 1 }
      : {}),
    updatedAt: completedAt,
  }
  return {
    session: moved,
    events: [
      {
        type: 'action-completed',
        sessionId: session.id,
        description: last.intent,
        passed: input.passed,
      },
    ],
  }
}

/** Append an observation. */
export function recordObservation(
  session: WorkflowGenerationSession,
  observation: Omit<GenerationObservation, 'at'> & { at?: number },
): WorkflowGenerationSession {
  return {
    ...session,
    observations: [
      ...session.observations,
      {
        at: observation.at ?? Date.now(),
        kind: observation.kind,
        detail: observation.detail,
        ...(observation.url ? { url: observation.url } : {}),
      },
    ],
    updatedAt: Date.now(),
  }
}

/** Mark the last failure as locally recovered (spec §4 ACTION_FAILURE loop). */
export function markFailureRecovered(session: WorkflowGenerationSession): TransitionResult {
  const lastFailure = session.failures.at(-1)
  if (!lastFailure) return { session, events: [] }
  const failures = [...session.failures]
  failures[failures.length - 1] = { ...lastFailure, recovered: true }
  const moved: WorkflowGenerationSession = { ...session, failures, updatedAt: Date.now() }
  return {
    session: moved,
    events: [{ type: 'recovery', sessionId: session.id, description: lastFailure.message }],
  }
}

// --- Goal spec / candidate ----------------------------------------------------

/** Attach the goal contract (the agent produced it during understanding). */
export function attachGoalSpec(
  session: WorkflowGenerationSession,
  goalSpec: WorkflowGoalSpec,
): WorkflowGenerationSession {
  return { ...session, goalSpec, updatedAt: Date.now() }
}

/** Attach the compiled candidate (the `compiling` phase output). */
export function attachWorkflowCandidate(
  session: WorkflowGenerationSession,
  candidate: Workflow,
): WorkflowGenerationSession {
  return {
    ...session,
    workflowCandidate: candidate,
    workflowId: candidate.id,
    updatedAt: Date.now(),
  }
}

// --- Selectors ----------------------------------------------------------------

/** Whether the session is still running background work. */
export function generationIsActive(session: WorkflowGenerationSession): boolean {
  return ACTIVE_PHASES.has(session.phase)
}

/** The successful action traces (what the compiler may consume). */
export function successfulTraces(
  session: WorkflowGenerationSession,
): GenerationActionTrace[] {
  return session.actionTrace.filter(
    (trace) => trace.result === 'success' && trace.nodeId,
  )
}

/**
 * Whether a goal gate passes: when the session carries a goal spec it also
 * needs at least one recorded goal verification that passed. Read-only tasks
 * without a goal skip (nothing to verify).
 */
export function goalGatePassed(session: WorkflowGenerationSession): boolean {
  if (!session.goalSpec) return true
  return session.actionTrace.some(
    (trace) => trace.verification?.kind === 'goal' && trace.verification.passed,
  )
}

/** Type narrowing helper for node lists (used by compiler integration). */
export function asWorkflowNodes(nodes: unknown): WorkflowNode[] {
  return Array.isArray(nodes) ? (nodes as WorkflowNode[]) : []
}

/** Re-export for callers that consume conditions through this module. */
export type { WorkflowCondition }
