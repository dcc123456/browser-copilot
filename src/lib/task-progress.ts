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

export type GoalStatus = 'active' | 'done' | 'abandoned'

export interface TaskGoal {
  summary: string
  startedAt: number
  status: GoalStatus
  /**
   * Result-based stagnation state, persisted WITH the goal: a service worker
   * restart must not reset the no-progress counters. Absent on older records
   * means a fresh segment.
   */
  stagnation?: ProgressState
  /** Locatable evidence submitted with the completion declaration. */
  evidence?: GoalEvidence[]
  /** When this goal was moved into the bounded archive; prevents double entries. */
  archivedAt?: number
}

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
): TaskProgress {
  const summary = goalSummary.trim().slice(0, 400)
  return {
    ...progress,
    ...(summary
      ? {
          goal: {
            summary,
            startedAt: now,
            status: 'active' as const,
          },
        }
      : {}),
    steps: [],
    updatedAt: now,
  }
}

/**
 * A goal lives as long as its TASK, not the conversation.
 * A non-active goal is finished: a new user instruction archives it and starts
 * a fresh goal instead of inheriting state from the old task.
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

/**
 * Completion is a DECLARATION, never an inference: the caller must submit
 * locatable evidence, and "no failed step" is not "done" — inferring that
 * would mark every quiet turn done on the next message. Returns undefined when
 * the evidence is unusable.
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

function coerceArchivedGoal(value: unknown): ArchivedGoal | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const summary = asString(record['summary']).trim()
  const status = asString(record['status'])
  if (!summary) return null
  if (status !== 'done' && status !== 'abandoned') return null
  return {
    summary: summary.slice(0, 400),
    startedAt: asNumber(record['startedAt']),
    status,
    endedAt: asNumber(record['endedAt']),
    completedSteps: Array.isArray(record['completedSteps'])
      ? record['completedSteps']
          .map(coerceStep)
          .filter((step): step is TaskProgressStep => step !== null)
          .slice(-12)
      : [],
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
  if (record['version'] !== 1 && record['version'] !== 2) return undefined
  const conversationId = asString(record['conversationId']).trim()
  if (!conversationId) return undefined
  const rawGoal = record['goal']
  let goal: TaskGoal | undefined
  if (rawGoal && typeof rawGoal === 'object') {
    const raw = rawGoal as Record<string, unknown>
    const summary = asString(raw['summary']).trim()
    if (summary) {
      const status = asString(raw['status'])
      const archivedAt = asNumber(raw['archivedAt'])
      goal = {
        summary: summary.slice(0, 400),
        startedAt: asNumber(raw['startedAt']),
        // Records written with a budget gate may still hold `paused`; with the
        // gate gone there is no way to resume it, so treat it as active.
        status:
          status === 'paused' ||
          !(['active', 'done', 'abandoned'] as const).includes(status as GoalStatus)
            ? 'active'
            : (status as GoalStatus),
        ...(Number.isFinite(archivedAt) && archivedAt > 0
          ? { archivedAt: Math.floor(archivedAt) }
          : {}),
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
  const archivedGoals = Array.isArray(record['archivedGoals'])
    ? record['archivedGoals']
        .map(coerceArchivedGoal)
        .filter((archived): archived is ArchivedGoal => archived !== null)
        .slice(-MAX_ARCHIVED_GOALS)
    : []
  return {
    version: 2,
    conversationId,
    ...(goal ? { goal } : {}),
    steps: steps.slice(-MAX_TASK_STEPS),
    destructiveOps: destructiveOps.slice(-MAX_DESTRUCTIVE_OPS),
    ...(archivedGoals.length > 0 ? { archivedGoals } : {}),
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
