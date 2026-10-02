/**
 * Persistence for scheduled tasks, their run logs, and Feishu settings.
 *
 * Kept separate from `storage.ts`, which already handles settings/skills/history:
 * the scheduler has its own keyspace and its own migration concerns, and lumping
 * them together would make the schema harder to reason about.
 *
 * @module lib/task-store
 */

import { newId } from './storage'
import { fileStorageArea } from './fs-store'
import { withKeyLock } from './key-lock'
import { capPersistedStrings, jsonBytes } from './persist-budget'
import {
  DEFAULT_TASK_MAX_TOOL_ROUNDS,
  EMPTY_FEISHU_CONFIG,
  type FeishuConfig,
  type ScheduledTask,
  type TaskKind,
  type TaskRunLog,
  type TaskRunOutcome,
  type TaskRunStep,
} from './scheduler-types'
import { normalizeSchedule } from './schedule'

/** Clamps a per-task tool-round budget to a sane positive range. Exported so
 * the agent's `create_scheduled_task` tool applies the same clamp as storage. */
export function coerceMaxToolRounds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TASK_MAX_TOOL_ROUNDS
  return Math.min(500, Math.max(1, Math.round(n)))
}

const KEY_TASKS = 'scheduledTasks'
const KEY_RUNS = 'scheduledTaskRuns'
const KEY_FEISHU = 'feishuConfig'

/**
 * The active storage area: files when a directory is configured and granted,
 * otherwise the `chrome.storage.local` mirror (see `lib/fs-store.ts`).
 */
const area = fileStorageArea()

/** Hard cap so a daily task running for years cannot grow storage unbounded. */
export const MAX_RUN_LOGS = 100

/**
 * Byte budget for the whole `scheduledTaskRuns` key. The count cap cannot bound
 * it: one workflow run with debug mode on writes a step per block, and the
 * variable bags those steps carry can hold megabyte image data URLs. Under the
 * count limit such a list still exceeds what the storage fallback can park — and
 * a value the fallback refuses is lost whole, so the run log would lose every
 * run it held, not just the oversized one. Oldest runs are shed to stay inside.
 */
const MAX_STORED_RUN_BYTES = 1_500_000

/**
 * Serializes read-modify-write cycles per storage key.
 *
 * Every mutation below reads the whole array under its key, edits it and writes
 * it back. Two runs settling at the same moment therefore raced: both read the
 * same base list and the later write silently dropped the other's entry, so a
 * finished run could disappear from the log entirely. Storage offers no
 * compare-and-swap, so the mutations are queued behind one another per key
 * instead — the shared implementation lives in `lib/key-lock.ts`.
 */

function asTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ScheduledTask>
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const kind: TaskKind =
    v.kind === 'workflow'
      ? 'workflow'
      : v.kind === 'github-review-requests' || v.kind === 'agent-prompt'
        ? v.kind
        : 'agent-prompt'
  return {
    id: v.id,
    name: v.name || 'Task',
    enabled: v.enabled !== false,
    schedule: normalizeSchedule(v.schedule),
    kind,
    prompt: typeof v.prompt === 'string' ? v.prompt : undefined,
    workflowId: typeof v.workflowId === 'string' ? v.workflowId : undefined,
    maxToolRounds: coerceMaxToolRounds(v.maxToolRounds),
    notifyFeishu: v.notifyFeishu === true,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
    lastRunAt: typeof v.lastRunAt === 'number' ? v.lastRunAt : undefined,
    lastStatus:
      v.lastStatus === 'ok' || v.lastStatus === 'failed' || v.lastStatus === 'skipped'
        ? v.lastStatus
        : undefined,
    lastSummary: typeof v.lastSummary === 'string' ? v.lastSummary : undefined,
    lastError: typeof v.lastError === 'string' ? v.lastError : undefined,
  }
}

export async function listTasks(): Promise<ScheduledTask[]> {
  const stored = await area.get(KEY_TASKS)
  const list = stored[KEY_TASKS]
  if (!Array.isArray(list)) return []
  return list
    .map(asTask)
    .filter((task): task is ScheduledTask => task !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getTask(id: string): Promise<ScheduledTask | undefined> {
  return (await listTasks()).find((task) => task.id === id)
}

export async function saveTask(task: ScheduledTask): Promise<void> {
  await withKeyLock(KEY_TASKS, async () => {
    const list = await listTasks()
    const index = list.findIndex((existing) => existing.id === task.id)
    const normalized: ScheduledTask = { ...task, updatedAt: Date.now() }
    if (index >= 0) list[index] = normalized
    else list.push(normalized)
    await area.set({ [KEY_TASKS]: list })
  })
}

export function createDraft(partial?: Partial<ScheduledTask>): ScheduledTask {
  const now = Date.now()
  return {
    id: newId(),
    name: partial?.name ?? '',
    enabled: partial?.enabled ?? true,
    schedule: partial?.schedule ?? { kind: 'daily', hour: 9, minute: 0 },
    kind: partial?.kind ?? 'agent-prompt',
    prompt: partial?.prompt ?? '',
    maxToolRounds:
      partial && typeof partial.maxToolRounds === 'number'
        ? coerceMaxToolRounds(partial.maxToolRounds)
        : DEFAULT_TASK_MAX_TOOL_ROUNDS,
    notifyFeishu: partial?.notifyFeishu ?? false,
    createdAt: now,
    updatedAt: now,
  }
}

export async function deleteTask(id: string): Promise<void> {
  await withKeyLock(KEY_TASKS, async () => {
    const list = await listTasks()
    await area.set({
      [KEY_TASKS]: list.filter((task) => task.id !== id),
    })
  })
}

/** Patches the last-run state shown in the UI, without touching other fields. */
export async function recordTaskRun(
  id: string,
  result: Pick<ScheduledTask, 'lastStatus' | 'lastSummary' | 'lastError'>,
): Promise<void> {
  await withKeyLock(KEY_TASKS, async () => {
    const list = await listTasks()
    const task = list.find((entry) => entry.id === id)
    if (!task) return
    task.lastRunAt = Date.now()
    task.lastStatus = result.lastStatus
    task.lastSummary = result.lastSummary
    task.lastError = result.lastError
    task.updatedAt = Date.now()
    await area.set({ [KEY_TASKS]: list })
  })
}

// --- Run logs ----------------------------------------------------------------

function asRun(value: unknown): TaskRunLog | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<TaskRunLog>
  if (v.taskId !== undefined && typeof v.taskId !== 'string') return null
  return {
    id: v.id as string,
    ...(typeof v.taskId === 'string' ? { taskId: v.taskId } : {}),
    ...(typeof v.workflowId === 'string' ? { workflowId: v.workflowId } : {}),
    ...(typeof v.label === 'string' ? { label: v.label } : {}),
    ...(v.source === 'chat' ||
    v.source === 'schedule' ||
    v.source === 'feishu' ||
    v.source === 'manual'
      ? { source: v.source }
      : {}),
    trigger: v.trigger === 'feishu' || v.trigger === 'manual' ? v.trigger : 'schedule',
    ...(typeof v.startedAt === 'number' ? { startedAt: v.startedAt } : {}),
    ...(typeof v.finishedAt === 'number' ? { finishedAt: v.finishedAt } : {}),
    ...(v.outcome === 'ok' ||
    v.outcome === 'failed' ||
    v.outcome === 'cancelled' ||
    v.outcome === 'skipped'
      ? { outcome: v.outcome }
      : {}),
    at: typeof v.at === 'number' ? v.at : Date.now(),
    ok: v.ok === true,
    skipped: v.skipped === true,
    summary: typeof v.summary === 'string' ? v.summary : '',
    notified: v.notified === true,
    error: typeof v.error === 'string' ? v.error : undefined,
    // How the run recovered. The health summary counts these, so they must
    // survive the round trip — a run that only exists in memory cannot tell a
    // restarted worker that it needed an AI repair.
    ...(typeof v.failureCategory === 'string' ? { failureCategory: v.failureCategory } : {}),
    ...(v.resumed === true ? { resumed: true } : {}),
    ...(v.repaired === true ? { repaired: true } : {}),
    ...(v.takeover === true ? { takeover: true } : {}),
    ...(Array.isArray(v.steps)
      ? {
          steps: v.steps
            .filter(
              (s): s is TaskRunStep =>
                !!s &&
                typeof s === 'object' &&
                typeof s.text === 'string' &&
                (s.kind === 'tool' ||
                  s.kind === 'status' ||
                  s.kind === 'result' ||
                  s.kind === 'error' ||
                  s.kind === 'info'),
            )
            .map((s) => ({
              at: typeof s.at === 'number' ? s.at : 0,
              kind: s.kind,
              // Caps are applied on read as well as on write: a log written by an
              // older build can already hold a data URL, and this is the one
              // place every reader passes through.
              text: capPersistedStrings(s.text) as string,
              ...(typeof s.nodeId === 'string' ? { nodeId: s.nodeId } : {}),
              ...(typeof s.label === 'string' ? { label: s.label } : {}),
            })),
        }
      : {}),
  }
}

export async function listRuns(taskId?: string): Promise<TaskRunLog[]> {
  const stored = await area.get(KEY_RUNS)
  const list = stored[KEY_RUNS]
  if (!Array.isArray(list)) return []
  return (
    list
      .map(asRun)
      .filter((run): run is TaskRunLog => run !== null)
      // Chat turns are conversation turns, not task runs — keep them out of the
      // task run history (and out of the board hydrated from it).
      .filter((run) => run.source !== 'chat')
      .filter((run) => (taskId ? run.taskId === taskId : true))
      .sort((a, b) => b.at - a.at)
  )
}

/**
 * Write the run log: count-capped, then byte-capped (oldest runs shed first).
 *
 * Every entry is pushed through {@link asRun} before it lands, so what is
 * stored is exactly what a reader gets back. That matters because the caller
 * hands over the in-memory steps of a finished run, and a debug-mode step
 * carries its block's whole variable bag — screenshots and generated images as
 * base64 data URLs, megabytes each. Those bags are dropped on read already, so
 * persisting them bought nothing and cost the key its durability: over the
 * fallback's per-entry budget a value is refused outright, and the run log would
 * lose every run it held.
 */
async function persistRuns(list: TaskRunLog[]): Promise<void> {
  const runs = list
    .map(asRun)
    .filter((run): run is TaskRunLog => run !== null)
    .slice(0, MAX_RUN_LOGS)
  const bytes = runs.map(jsonBytes)
  let total = bytes.reduce((sum, b) => sum + b + 1, 0) // +1 per list separator
  let end = runs.length
  while (total > MAX_STORED_RUN_BYTES && end > 1) {
    end--
    total -= (bytes[end] ?? 0) + 1
  }
  await area.set({ [KEY_RUNS]: runs.slice(0, end) })
}

export async function addRun(run: Omit<TaskRunLog, 'id' | 'at'>): Promise<TaskRunLog> {
  return withKeyLock(KEY_RUNS, async () => {
    const list = await listRuns()
    const entry: TaskRunLog = { ...run, id: newId(), at: Date.now() }
    list.unshift(entry)
    await persistRuns(list)
    return entry
  })
}

/**
 * Persists a fully-finished run (label, source, outcome, steps, and the
 * workflow it executed) into the run log. This is the single persistence path
 * invoked from running-tasks when a run settles, so every entry point — chat
 * turns, scheduled/Feishu/manual task runs, and ad-hoc Feishu instructions —
 * survives a service-worker restart. The `trigger` field is derived from
 * `source` for back-compat with older UI/storage versions.
 */
export interface FinishedRunInput {
  runId: string
  taskId?: string
  /** Saved workflow this run executed, when it was a workflow run. */
  workflowId?: string
  label?: string
  source: 'chat' | 'schedule' | 'feishu' | 'manual'
  startedAt?: number
  finishedAt?: number
  outcome: TaskRunOutcome
  summary?: string
  error?: string
  steps?: TaskRunStep[]
  /** How the run recovered, forwarded from the in-memory board (see TaskRunLog). */
  failureCategory?: string
  resumed?: boolean
  repaired?: boolean
  takeover?: boolean
}

export async function recordFinishedRun(input: FinishedRunInput): Promise<TaskRunLog | null> {
  // Chat turns are conversation history, not task runs. Never persist them into
  // the task run log, so it stays a clean record of scheduled/Feishu/manual runs.
  if (input.source === 'chat') return null
  return withKeyLock(KEY_RUNS, async () => {
    const list = await listRuns()
    const trigger: TaskRunLog['trigger'] =
      input.source === 'feishu' ? 'feishu' : input.source === 'manual' ? 'manual' : 'schedule'
    const entry: TaskRunLog = {
      id: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.label ? { label: input.label } : {}),
      source: input.source,
      trigger,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      finishedAt: input.finishedAt ?? Date.now(),
      outcome: input.outcome,
      at: input.finishedAt ?? Date.now(),
      ok: input.outcome === 'ok',
      skipped: input.outcome === 'skipped',
      summary: input.summary ?? '',
      ...(input.error ? { error: input.error } : {}),
      ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
      ...(input.resumed ? { resumed: true } : {}),
      ...(input.repaired ? { repaired: true } : {}),
      ...(input.takeover ? { takeover: true } : {}),
      ...(input.steps && input.steps.length > 0 ? { steps: input.steps } : {}),
    }
    // If a placeholder/earlier record with the same id exists, replace it.
    const existing = list.findIndex((r) => r.id === input.runId)
    if (existing !== -1) list[existing] = entry
    else list.unshift(entry)
    await persistRuns(list)
    return entry
  })
}

export async function clearRuns(taskId?: string): Promise<void> {
  await withKeyLock(KEY_RUNS, async () => {
    if (!taskId) {
      await area.set({ [KEY_RUNS]: [] })
      return
    }
    const list = await listRuns()
    await persistRuns(list.filter((run) => run.taskId !== taskId))
  })
}

/** Deletes a single run-log entry by its id. */
export async function deleteRun(id: string): Promise<void> {
  await withKeyLock(KEY_RUNS, async () => {
    const list = await listRuns()
    await persistRuns(list.filter((run) => run.id !== id))
  })
}

// --- Feishu config -----------------------------------------------------------

function asFeishu(value: unknown): FeishuConfig {
  if (!value || typeof value !== 'object') return { ...EMPTY_FEISHU_CONFIG }
  const v = value as Partial<FeishuConfig>
  return {
    webhookUrl: typeof v.webhookUrl === 'string' ? v.webhookUrl.trim() : '',
    webhookSecret: typeof v.webhookSecret === 'string' ? v.webhookSecret : '',
    appId: typeof v.appId === 'string' ? v.appId.trim() : '',
    appSecret: typeof v.appSecret === 'string' ? v.appSecret : '',
    botEnabled: v.botEnabled === true,
  }
}

export async function getFeishuConfig(): Promise<FeishuConfig> {
  const stored = await area.get(KEY_FEISHU)
  return asFeishu(stored[KEY_FEISHU])
}

export async function saveFeishuConfig(config: FeishuConfig): Promise<FeishuConfig> {
  const normalized = asFeishu(config)
  await area.set({ [KEY_FEISHU]: normalized })
  return normalized
}
