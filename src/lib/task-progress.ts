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
}

/** Default per-goal round budget when the user has not set one. */
export const DEFAULT_GOAL_MAX_ROUNDS = 20
/** Bounded: a long task cannot grow its change log without limit. */
export const MAX_BUDGET_LOG = 20

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
          },
        }
      : {}),
    steps: [],
    updatedAt: now,
  }
}

/** Records one spent round against the goal budget. */
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
    },
    updatedAt: now,
  }
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
  const used = goal.budgetLog.filter((entry) => entry.kind === 'auto-renew').length
  if (used >= options.k) return { allowed: false, reason: 'k-exhausted' }
  if (!options.progressDetected) return { allowed: false, reason: 'no-progress' }
  return { allowed: true, reason: 'allowed' }
}

export interface GoalBudgetReport {
  goal: string
  completed: number
  steps: TaskProgressStep[]
  remainingRounds: number
  usedRounds: number
  maxRounds: number
  nextActions: ('renew' | 'change-goal' | 'stop')[]
}

/**
 * The six-item budget report (spec R10): goal, done, remaining, stop reason,
 * cost, next actions. Pure so the panel card and the status line render the
 * same facts.
 */
export function goalBudgetReport(
  progress: TaskProgress,
  cost?: TaskCost,
): GoalBudgetReport | undefined {
  const goal = progress.goal
  if (!goal) return undefined
  const completed = progress.steps.filter((step) => step.ok)
  return {
    goal: goal.summary,
    completed: completed.length,
    steps: completed.slice(-RESUME_STEP_LINES),
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
