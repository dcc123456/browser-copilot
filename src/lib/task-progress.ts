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

export interface TaskGoal {
  summary: string
  startedAt: number
}

export interface TaskProgress {
  version: 1
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
  return { version: 1, conversationId, steps: [], destructiveOps: [], updatedAt: now }
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
    ...(summary ? { goal: { summary, startedAt: now } } : {}),
    steps: [],
    updatedAt: now,
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
  if (record['version'] !== 1) return undefined
  const conversationId = asString(record['conversationId']).trim()
  if (!conversationId) return undefined
  const rawGoal = record['goal']
  let goal: TaskGoal | undefined
  if (rawGoal && typeof rawGoal === 'object') {
    const summary = asString((rawGoal as Record<string, unknown>)['summary']).trim()
    if (summary) {
      goal = {
        summary: summary.slice(0, 400),
        startedAt: asNumber((rawGoal as Record<string, unknown>)['startedAt']),
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
    version: 1,
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
