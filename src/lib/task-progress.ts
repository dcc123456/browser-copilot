/**
 * Durable per-conversation task progress for long-horizon chat turns.
 *
 * A turn's transcript is persisted (see `lib/progress-checkpoint`), but it
 * carries no machine-readable "what is done / what is next / what must never
 * run again". Without that, a resumed long task re-explores finished work and
 * can replay an irreversible action. This module owns the shape and the pure
 * reducers; `lib/storage` owns persistence.
 *
 * The record deliberately does NOT count tokens: `lib/token-ledger` is the
 * single source of truth for spend (spec AC-10), so the resume note reads the
 * ledger through `taskTokenCost` instead of keeping a second counter here.
 *
 * Chrome-free by design (AGENTS §5.7).
 *
 * @module lib/task-progress
 */
import type { ProgressState } from './progress-signal'
import { entityKeyFor } from './token-ledger'

/** One executed tool step, in model-facing order. */
export interface TaskProgressStep {
  at: number
  tool: string
  /** Human summary produced by `describeAction`/`shortSummary`; never raw args. */
  summary: string
  ok: boolean
  url?: string
}

/** An action whose repeat could duplicate an external effect (order, post, send). */
export interface DestructiveOperation {
  at: number
  tool: string
  /** Canonical tool+args digest; the args themselves may hold secrets, so only this is stored. */
  fingerprint: string
  summary: string
}

export type GoalStatus = 'active' | 'paused' | 'done' | 'abandoned'

/** One budget change, kept so auto-renewal can never be silent (spec R10). */
export interface GoalBudgetChange {
  at: number
  kind: 'renew' | 'auto-renew' | 'edit'
  /** Rounds added by this change. */
  roundsAdded?: number
  /** Who triggered it. */
  actor: 'user' | 'strategy'
  /** For auto-renewal: evidence that the previous segment made progress. */
  evidence?: string
}

export interface TaskGoal {
  summary: string
  startedAt: number
  /** Explicit round budget; the only termination-by-count the product allows. */
  maxRounds: number
  /** Rounds already spent against the budget (metric + budget accounting). */
  roundsStarted: number
  status: GoalStatus
  budgetLog: GoalBudgetChange[]
  /**
   * Result-based stagnation state, persisted WITH the goal: a service worker
   * restart must not reset the no-progress counters any more than it resets K
   * (spec R1③ / R10). Absent on older records = a fresh segment.
   */
  stagnation?: ProgressState
  /**
   * Monotonic count of automatic renewals. NOT derived from `budgetLog`: that
   * log is a bounded display artifact, so deriving the K quota from it made
   * K > MAX_BUDGET_LOG permanently allow renewals (the quota could never reach
   * the cap). A quota counter must be monotonic and unbounded.
   */
  autoRenewals: number
  /** Locatable evidence submitted with the completion declaration. */
  evidence?: GoalEvidence[]
  /** When this goal was moved into the bounded archive; prevents double entries. */
  archivedAt?: number
}

/** Default per-goal round budget when the user has not set one. */
export const DEFAULT_GOAL_MAX_ROUNDS = 20
/** Bounded: a long task cannot grow its change log without limit. */
export const MAX_BUDGET_LOG = 20
/** Default increment when a budget is renewed without an explicit size. */
export const DEFAULT_GOAL_RENEW_ROUNDS = 20
/** How many finished goals stay readable ("what did the last task do?"). */
export const MAX_ARCHIVED_GOALS = 3

/** Evidence a completion claim must carry; the system only checks it is locatable. */
export interface GoalEvidence {
  kind: 'url' | 'element' | 'text'
  value: string
}

/** A finished goal, kept bounded so "what did the previous task do" stays answerable. */
export interface ArchivedGoal {
  summary: string
  startedAt: number
  status: 'done' | 'abandoned'
  endedAt: number
  completedSteps: TaskProgressStep[]
  autoRenewals: number
}

export interface TaskProgress {
  version: 2
  conversationId: string
  goal?: TaskGoal
  steps: TaskProgressStep[]
  /**
   * Cross-turn on purpose (spec R4⑤): a step list may age out, but an
   * irreversible action must stay blocking for the whole conversation.
   */
  destructiveOps: DestructiveOperation[]
  /** Bounded history of finished goals (newest last). */
  archivedGoals?: ArchivedGoal[]
  updatedAt: number
}

/** Bounded so one runaway task cannot grow the stored value without limit. */
export const MAX_TASK_STEPS = 40
/** Irreversible actions are far rarer than steps; keep more history than steps. */
export const MAX_DESTRUCTIVE_OPS = 50
/** Cap on the model-facing resume note, in characters. */
const MAX_RESUME_NOTE_CHARS = 1_600
/** How many recent completed steps the resume note lists. */
const RESUME_STEP_LINES = 12

export function emptyTaskProgress(conversationId: string, now = Date.now()): TaskProgress {
  return { version: 2, conversationId, steps: [], destructiveOps: [], updatedAt: now }
}

/** Sets (or replaces) the task goal. Steps belong to one goal, so they restart with it. */
export function beginTask(
  progress: TaskProgress,
  goalSummary: string,
  now = Date.now(),
  maxRounds = DEFAULT_GOAL_MAX_ROUNDS,
): TaskProgress {
  const summary = goalSummary.trim().slice(0, 400)
  const budget =
    Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : DEFAULT_GOAL_MAX_ROUNDS
  return {
    ...progress,
    ...(summary
      ? {
          goal: {
            summary,
            startedAt: now,
            maxRounds: budget,
            roundsStarted: 0,
            status: 'active' as const,
            budgetLog: [],
            autoRenewals: 0,
          },
        }
      : {}),
    steps: [],
    updatedAt: now,
  }
}

/**
 * A goal lives as long as its TASK, not the conversation (spec R10 R-1/R-3).
 * A non-active goal is finished: a new user instruction archives it and starts
 * a fresh goal instead of inheriting a budget/paused state from the old task.
 */
export function archiveGoal(
  progress: TaskProgress,
  status: 'done' | 'abandoned' = 'abandoned',
  now = Date.now(),
): TaskProgress {
  const goal = progress.goal
  if (!goal) return progress
  // Archive exactly once: abandoning a goal and then sending the next message
  // must not append the same finished task twice.
  if (goal.archivedAt !== undefined) return progress
  const recorded: ArchivedGoal = {
    summary: goal.summary,
    startedAt: goal.startedAt,
    status,
    endedAt: now,
    completedSteps: progress.steps.filter((step) => step.ok).slice(-12),
    autoRenewals: goal.autoRenewals,
  }
  return {
    ...progress,
    goal: { ...goal, status, archivedAt: now },
    archivedGoals: [...(progress.archivedGoals ?? []), recorded].slice(-MAX_ARCHIVED_GOALS),
    updatedAt: now,
  }
}

/** Whether an incoming message starts a new task rather than continuing one. */
export function startsNewGoal(progress: TaskProgress): boolean {
  const goal = progress.goal
  return goal === undefined || goal.status !== 'active'
}

/** Records one spent round against the goal budget. */
/**
 * Completion is a DECLARATION, never an inference (spec R10 / AC-17): the
 * caller must submit locatable evidence, and "no failed step" is not "done" —
 * inferring that would mark every quiet turn done and reset budget and K on
 * the next message. Returns undefined when the evidence is unusable.
 */
export function completeGoal(
  progress: TaskProgress,
  input: { summary?: string; evidence: GoalEvidence[] },
  now = Date.now(),
): TaskProgress | undefined {
  const goal = progress.goal
  if (!goal || goal.status !== 'active') return undefined
  const usable = input.evidence
    .map((entry) => ({ kind: entry.kind, value: entry.value.trim() }))
    .filter((entry) => entry.value.length > 0)
  if (usable.length === 0) return undefined
  const summary = input.summary?.trim() || goal.summary
  // Completion archives immediately: the finished task must be readable even
  // before the next message arrives, and archiving here makes the later
  // start-new-goal path skip it instead of duplicating the record.
  return archiveGoal(
    {
      ...progress,
      goal: {
        ...goal,
        summary: summary.slice(0, 400),
        status: 'done',
        evidence: usable.slice(0, 8),
      },
      updatedAt: now,
    },
    'done',
    now,
  )
}

export function recordGoalRound(progress: TaskProgress, now = Date.now()): TaskProgress {
  if (!progress.goal) return progress
  return {
    ...progress,
    goal: { ...progress.goal, roundsStarted: progress.goal.roundsStarted + 1 },
    updatedAt: now,
  }
}

export function remainingGoalRounds(progress: TaskProgress): number {
  if (!progress.goal) return 0
  return Math.max(0, progress.goal.maxRounds - progress.goal.roundsStarted)
}

export function goalBudgetExhausted(progress: TaskProgress): boolean {
  return progress.goal !== undefined && remainingGoalRounds(progress) <= 0
}

/**
 * Renews the budget by an INCREMENT. Never resets `roundsStarted`, the step
 * list, or the stagnation counter (which a caller keeps with the goal): a
 * renewal extends the same task, it does not start a new one.
 */
export function renewGoalBudget(
  progress: TaskProgress,
  rounds: number,
  actor: GoalBudgetChange['actor'],
  now = Date.now(),
  evidence?: string,
): TaskProgress {
  const goal = progress.goal
  if (!goal || !Number.isFinite(rounds) || rounds <= 0) return progress
  const added = Math.floor(rounds)
  const entry: GoalBudgetChange = {
    at: now,
    kind: actor === 'user' ? 'renew' : 'auto-renew',
    roundsAdded: added,
    actor,
    ...(evidence ? { evidence: evidence.slice(0, 300) } : {}),
  }
  return {
    ...progress,
    goal: {
      ...goal,
      maxRounds: goal.maxRounds + added,
      status: goal.status === 'paused' ? 'active' : goal.status,
      budgetLog: [...goal.budgetLog, entry].slice(-MAX_BUDGET_LOG),
      autoRenewals: actor === 'strategy' ? goal.autoRenewals + 1 : goal.autoRenewals,
    },
    updatedAt: now,
  }
}

/** Edits the explicit budget (user action); the change is logged, never hidden. */
export function setGoalBudget(
  progress: TaskProgress,
  maxRounds: number,
  now = Date.now(),
): TaskProgress {
  const goal = progress.goal
  if (!goal || !Number.isFinite(maxRounds) || maxRounds <= 0) return progress
  const next = Math.floor(maxRounds)
  return {
    ...progress,
    goal: {
      ...goal,
      maxRounds: next,
      status: next > goal.roundsStarted && goal.status === 'paused' ? 'active' : goal.status,
      budgetLog: [
        ...goal.budgetLog,
        {
          at: now,
          kind: 'edit' as const,
          actor: 'user' as const,
          roundsAdded: next - goal.maxRounds,
        },
      ].slice(-MAX_BUDGET_LOG),
    },
    updatedAt: now,
  }
}

/** Why a typed budget cannot be applied, or null when it can. */
export type GoalBudgetDraftProblem = 'empty' | 'invalid' | 'below-used'

/**
 * Validates the budget a user typed before it reaches a command.
 *
 * A value below the rounds already spent is refused, not clamped: applying it
 * would leave a paused task showing "20/5", an edit that reads as accepted
 * while changing nothing (spec AC-13⑩).
 */
export function goalBudgetDraftProblem(
  draft: string,
  usedRounds: number,
): GoalBudgetDraftProblem | null {
  if (draft.trim() === '') return 'empty'
  const value = Number(draft)
  if (!Number.isFinite(value) || value < 1) return 'invalid'
  return value < usedRounds ? 'below-used' : null
}

export interface AutoRenewDecision {
  allowed: boolean
  reason: 'not-paused' | 'attended' | 'k-exhausted' | 'no-progress' | 'allowed'
}

/**
 * K is an unattended-only strategy (spec R10): with a human present the user
 * renews; without one, renewal requires PROGRESS in the segment that just ran —
 * otherwise auto-renewal would turn "stuck" into "silently burn another batch".
 */
export function autoRenewDecision(
  progress: TaskProgress,
  options: { unattended: boolean; k: number; progressDetected: boolean },
): AutoRenewDecision {
  const goal = progress.goal
  if (!goal || goal.status !== 'paused') return { allowed: false, reason: 'not-paused' }
  if (!options.unattended) return { allowed: false, reason: 'attended' }
  if (options.k <= 0) return { allowed: false, reason: 'k-exhausted' }
  const used = goal.autoRenewals
  if (used >= options.k) return { allowed: false, reason: 'k-exhausted' }
  if (!options.progressDetected) return { allowed: false, reason: 'no-progress' }
  return { allowed: true, reason: 'allowed' }
}

/** The six stop classes a goal may end on (spec R3/R10). */
export type GoalStopReason =
  'achieved' | 'blocked' | 'no-progress' | 'user-stop' | 'budget' | 'cost'

export interface GoalBudgetReport {
  goal: string
  /** How many steps succeeded. */
  completed: number
  /** The succeeded steps themselves — the evidence a report must show. */
  completedSteps: TaskProgressStep[]
  /** What is left: failed steps, or the explicit "continue from here" line. */
  unfinished: string[]
  stopReason: GoalStopReason
  remainingRounds: number
  usedRounds: number
  maxRounds: number
  nextActions: ('renew' | 'change-goal' | 'stop')[]
  cost?: TaskCost
}

/**
 * The six-item budget report (spec R10): goal, done, remaining, stop reason,
 * cost, next actions. Pure so the panel card and the status line render the
 * same facts.
 */
export function goalBudgetReport(
  progress: TaskProgress,
  cost?: TaskCost,
  stopReason: GoalStopReason = 'budget',
): GoalBudgetReport | undefined {
  const goal = progress.goal
  if (!goal) return undefined
  const completed = progress.steps.filter((step) => step.ok)
  const failed = progress.steps.filter((step) => !step.ok)
  return {
    goal: goal.summary,
    completed: completed.length,
    completedSteps: completed.slice(-RESUME_STEP_LINES),
    unfinished: failed
      .slice(-RESUME_STEP_LINES)
      .map((step) => `retry ${step.tool}: ${step.summary}${step.url ? ` @ ${step.url}` : ''}`),
    stopReason,
    remainingRounds: remainingGoalRounds(progress),
    usedRounds: goal.roundsStarted,
    maxRounds: goal.maxRounds,
    nextActions: ['renew', 'change-goal', 'stop'],
    ...(cost ? { cost } : {}),
  }
}

export function appendProgressStep(
  progress: TaskProgress,
  step: Omit<TaskProgressStep, 'at'>,
  now = Date.now(),
): TaskProgress {
  const steps = [...progress.steps, { ...step, at: now }].slice(-MAX_TASK_STEPS)
  return { ...progress, steps, updatedAt: now }
}

export function noteDestructiveOp(
  progress: TaskProgress,
  op: Omit<DestructiveOperation, 'at'>,
  now = Date.now(),
): TaskProgress {
  if (hasDestructiveOp(progress, op.fingerprint)) return progress
  const destructiveOps = [...progress.destructiveOps, { ...op, at: now }].slice(
    -MAX_DESTRUCTIVE_OPS,
  )
  return { ...progress, destructiveOps, updatedAt: now }
}

export function hasDestructiveOp(progress: TaskProgress, fingerprint: string): boolean {
  return progress.destructiveOps.some((op) => op.fingerprint === fingerprint)
}

/**
 * Risk reasons that can duplicate an EXTERNAL effect. `unknown-target` and
 * `persistent` are deliberately absent: blocking a repeat of an unidentified
 * click would invent a false positive, and persisted local state is idempotent.
 */
const IRREVERSIBLE_REASONS = new Set(['payment', 'destructive', 'sending'])

export function isIrreversibleReason(reason: string): boolean {
  return IRREVERSIBLE_REASONS.has(reason)
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * FNV-1a over the canonical arguments, as 64-bit hex.
 *
 * A digest rather than the arguments: destructive actions include credentials
 * and personal data, and this value is persisted. A collision only makes a
 * legitimate repeat look blocked — the safe direction — and 64 bits puts that
 * far below the rate of genuine duplicate submissions.
 */
export function fingerprintOf(tool: string, args: Record<string, unknown>): string {
  const text = `${tool}\u0000${canonicalJson(args)}`
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function coerceStep(value: unknown): TaskProgressStep | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const tool = asString(record['tool']).trim()
  if (!tool) return null
  return {
    at: asNumber(record['at']),
    tool,
    summary: asString(record['summary']).slice(0, 500),
    ok: record['ok'] === true,
    ...(asString(record['url']) ? { url: asString(record['url']).slice(0, 2_000) } : {}),
  }
}

function coerceEvidence(value: unknown): GoalEvidence | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = asString(record['kind'])
  const text = asString(record['value']).trim()
  if (!text) return null
  if (kind !== 'url' && kind !== 'element' && kind !== 'text') return null
  return { kind, value: text.slice(0, 2_000) }
}

function coerceStagnation(value: unknown): ProgressState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const signature = typeof record['signature'] === 'string' ? record['signature'] : null
  const url = typeof record['url'] === 'string' ? record['url'] : null
  const count = (key: string): number => Math.max(0, Math.floor(asNumber(record[key])))
  return {
    signature,
    url,
    unchanged: count('unchanged'),
    unreadable: count('unreadable'),
    waiting: count('waiting'),
  }
}

function coerceBudgetChange(value: unknown): GoalBudgetChange | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = asString(record['kind'])
  const actor = asString(record['actor'])
  if (!['renew', 'auto-renew', 'edit'].includes(kind)) return null
  if (actor !== 'user' && actor !== 'strategy') return null
  return {
    at: asNumber(record['at']),
    kind: kind as GoalBudgetChange['kind'],
    ...(asNumber(record['roundsAdded']) > 0
      ? { roundsAdded: Math.floor(asNumber(record['roundsAdded'])) }
      : {}),
    actor,
    ...(asString(record['evidence'])
      ? { evidence: asString(record['evidence']).slice(0, 300) }
      : {}),
  }
}

function coerceOp(value: unknown): DestructiveOperation | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const tool = asString(record['tool']).trim()
  const fingerprint = asString(record['fingerprint']).trim()
  if (!tool || !fingerprint) return null
  return {
    at: asNumber(record['at']),
    tool,
    fingerprint,
    summary: asString(record['summary']).slice(0, 500),
  }
}

/**
 * Validates a stored value. Storage is never trusted: a hand-edited or
 * older-version record must degrade to "no progress", never crash a turn.
 */
export function coerceTaskProgress(value: unknown): TaskProgress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  // Version 1 had no goal budget; migrate it with the default budget rather
  // than discarding the user's progress.
  if (record['version'] !== 1 && record['version'] !== 2) return undefined
  const conversationId = asString(record['conversationId']).trim()
  if (!conversationId) return undefined
  const rawGoal = record['goal']
  let goal: TaskGoal | undefined
  if (rawGoal && typeof rawGoal === 'object') {
    const raw = rawGoal as Record<string, unknown>
    const summary = asString(raw['summary']).trim()
    if (summary) {
      const maxRounds = asNumber(raw['maxRounds'])
      const status = asString(raw['status'])
      const budgetLog = Array.isArray(raw['budgetLog'])
        ? raw['budgetLog']
            .map((entry) => coerceBudgetChange(entry))
            .filter((entry): entry is GoalBudgetChange => entry !== null)
            .slice(-MAX_BUDGET_LOG)
        : []
      goal = {
        summary: summary.slice(0, 400),
        startedAt: asNumber(raw['startedAt']),
        maxRounds:
          Number.isFinite(maxRounds) && maxRounds > 0
            ? Math.floor(maxRounds)
            : DEFAULT_GOAL_MAX_ROUNDS,
        roundsStarted: Math.max(0, Math.floor(asNumber(raw['roundsStarted']))),
        status: (['active', 'paused', 'done', 'abandoned'] as const).includes(status as GoalStatus)
          ? (status as GoalStatus)
          : 'active',
        budgetLog,
        autoRenewals: Math.max(0, Math.floor(asNumber(raw['autoRenewals']))),
        ...(Array.isArray(raw['evidence'])
          ? {
              evidence: raw['evidence']
                .map((entry) => coerceEvidence(entry))
                .filter((entry): entry is GoalEvidence => entry !== null)
                .slice(0, 8),
            }
          : {}),
        ...(coerceStagnation(raw['stagnation'])
          ? { stagnation: coerceStagnation(raw['stagnation'])! }
          : {}),
      }
    }
  }
  const steps = Array.isArray(record['steps'])
    ? record['steps'].map(coerceStep).filter((step): step is TaskProgressStep => step !== null)
    : []
  const destructiveOps = Array.isArray(record['destructiveOps'])
    ? record['destructiveOps'].map(coerceOp).filter((op): op is DestructiveOperation => op !== null)
    : []
  return {
    version: 2,
    conversationId,
    ...(goal ? { goal } : {}),
    steps: steps.slice(-MAX_TASK_STEPS),
    destructiveOps: destructiveOps.slice(-MAX_DESTRUCTIVE_OPS),
    updatedAt: asNumber(record['updatedAt']),
  }
}

/** How much a task cost so far, read from the request ledger (never a second counter). */
export interface TaskCost {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  requests: number
}

/**
 * Sums the ledger's per-request records for one chat conversation since the
 * task began. Usage the detail window has already trimmed is simply absent —
 * the note says "at least" rather than inventing a number.
 */
export function taskTokenCost(
  records: readonly {
    at: number
    entityKey: string
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }[],
  conversationId: string,
  since: number,
): TaskCost {
  const entityKey = entityKeyFor('chat', conversationId)
  let cost: TaskCost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0 }
  for (const record of records) {
    if (record.entityKey !== entityKey || record.at < since) continue
    cost = {
      inputTokens: cost.inputTokens + record.inputTokens,
      cachedInputTokens: cost.cachedInputTokens + record.cachedInputTokens,
      outputTokens: cost.outputTokens + record.outputTokens,
      requests: cost.requests + 1,
    }
  }
  return cost
}

/**
 * Model-facing resume block appended to the system prompt for a resumed task.
 *
 * English like every other prompt fragment. Bounded: a long task must not pay
 * for its whole history a second time through this note.
 */
export function renderResumeNote(progress: TaskProgress, cost?: TaskCost): string {
  if (!progress.goal && progress.steps.length === 0) return ''
  const lines: string[] = ['## RESUMED TASK — durable progress from earlier turns']
  if (progress.goal) {
    lines.push(`Goal: ${progress.goal.summary}`)
    lines.push(`Started: ${new Date(progress.goal.startedAt).toISOString()}`)
  }
  if (progress.steps.length > 0) {
    const recent = progress.steps.slice(-RESUME_STEP_LINES)
    lines.push(
      `Steps already executed (oldest to newest, ${recent.length}/${progress.steps.length} shown):`,
    )
    for (const step of recent) {
      lines.push(
        `- ${step.ok ? 'ok' : 'FAILED'} ${step.tool}: ${step.summary}${step.url ? ` @ ${step.url}` : ''}`,
      )
    }
    lines.push(
      'Continue from the first unfinished step. Do not re-run a step that already succeeded unless its result is explicitly invalidated.',
    )
  }
  if (progress.destructiveOps.length > 0) {
    lines.push('Irreversible actions already executed — NEVER repeat these:')
    for (const op of progress.destructiveOps.slice(-RESUME_STEP_LINES)) {
      lines.push(`- ${op.tool}: ${op.summary}`)
    }
  }
  if (cost && cost.requests > 0) {
    lines.push(
      `Cost so far: ${cost.inputTokens} input (${cost.cachedInputTokens} cached), ${cost.outputTokens} output tokens across ${cost.requests} requests.`,
    )
  }
  const text = lines.join('\n')
  return text.length <= MAX_RESUME_NOTE_CHARS
    ? text
    : `${text.slice(0, MAX_RESUME_NOTE_CHARS - 1)}…`
}
