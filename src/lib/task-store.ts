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
import {
  EMPTY_FEISHU_CONFIG,
  type FeishuConfig,
  type ScheduledTask,
  type TaskKind,
  type TaskRunLog,
  type TaskRunOutcome,
  type TaskRunStep,
} from './scheduler-types'
import { normalizeSchedule } from './schedule'

const KEY_TASKS = 'scheduledTasks'
const KEY_RUNS = 'scheduledTaskRuns'
const KEY_FEISHU = 'feishuConfig'

/** Hard cap so a daily task running for years cannot grow storage unbounded. */
export const MAX_RUN_LOGS = 100

function asTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ScheduledTask>
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const kind: TaskKind =
    v.kind === 'github-review-requests' || v.kind === 'agent-prompt' ? v.kind : 'agent-prompt'
  return {
    id: v.id,
    name: v.name || 'Task',
    enabled: v.enabled !== false,
    schedule: normalizeSchedule(v.schedule),
    kind,
    prompt: typeof v.prompt === 'string' ? v.prompt : undefined,
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
  const stored = await chrome.storage.local.get(KEY_TASKS)
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
  const list = await listTasks()
  const index = list.findIndex((existing) => existing.id === task.id)
  const normalized: ScheduledTask = { ...task, updatedAt: Date.now() }
  if (index >= 0) list[index] = normalized
  else list.push(normalized)
  await chrome.storage.local.set({ [KEY_TASKS]: list })
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
    notifyFeishu: partial?.notifyFeishu ?? false,
    createdAt: now,
    updatedAt: now,
  }
}

export async function deleteTask(id: string): Promise<void> {
  const list = await listTasks()
  await chrome.storage.local.set({
    [KEY_TASKS]: list.filter((task) => task.id !== id),
  })
}

/** Patches the last-run state shown in the UI, without touching other fields. */
export async function recordTaskRun(
  id: string,
  result: Pick<ScheduledTask, 'lastStatus' | 'lastSummary' | 'lastError'>,
): Promise<void> {
  const list = await listTasks()
  const task = list.find((entry) => entry.id === id)
  if (!task) return
  task.lastRunAt = Date.now()
  task.lastStatus = result.lastStatus
  task.lastSummary = result.lastSummary
  task.lastError = result.lastError
  task.updatedAt = Date.now()
  await chrome.storage.local.set({ [KEY_TASKS]: list })
}

// --- Run logs ----------------------------------------------------------------

function asRun(value: unknown): TaskRunLog | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<TaskRunLog>
  if (v.taskId !== undefined && typeof v.taskId !== 'string') return null
  return {
    id: v.id as string,
    ...(typeof v.taskId === 'string' ? { taskId: v.taskId } : {}),
    ...(typeof v.label === 'string' ? { label: v.label } : {}),
    ...(v.source === 'chat' || v.source === 'schedule' || v.source === 'feishu' || v.source === 'manual'
      ? { source: v.source }
      : {}),
    trigger: v.trigger === 'feishu' || v.trigger === 'manual' ? v.trigger : 'schedule',
    ...(typeof v.startedAt === 'number' ? { startedAt: v.startedAt } : {}),
    ...(typeof v.finishedAt === 'number' ? { finishedAt: v.finishedAt } : {}),
    ...(v.outcome === 'ok' || v.outcome === 'failed' || v.outcome === 'cancelled' || v.outcome === 'skipped'
      ? { outcome: v.outcome }
      : {}),
    at: typeof v.at === 'number' ? v.at : Date.now(),
    ok: v.ok === true,
    skipped: v.skipped === true,
    summary: typeof v.summary === 'string' ? v.summary : '',
    notified: v.notified === true,
    error: typeof v.error === 'string' ? v.error : undefined,
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
              text: s.text,
            })),
        }
      : {}),
  }
}

export async function listRuns(taskId?: string): Promise<TaskRunLog[]> {
  const stored = await chrome.storage.local.get(KEY_RUNS)
  const list = stored[KEY_RUNS]
  if (!Array.isArray(list)) return []
  return list
    .map(asRun)
    .filter((run): run is TaskRunLog => run !== null)
    .filter((run) => (taskId ? run.taskId === taskId : true))
    .sort((a, b) => b.at - a.at)
}

export async function addRun(run: Omit<TaskRunLog, 'id' | 'at'>): Promise<TaskRunLog> {
  const list = await listRuns()
  const entry: TaskRunLog = { ...run, id: newId(), at: Date.now() }
  list.unshift(entry)
  await chrome.storage.local.set({ [KEY_RUNS]: list.slice(0, MAX_RUN_LOGS) })
  return entry
}

/**
 * Persists a fully-finished run (label, source, outcome, steps) into the run
 * log. This is the single persistence path invoked from running-tasks when a
 * run settles, so every entry point — chat turns, scheduled/Feishu/manual task
 * runs, and ad-hoc Feishu instructions — survives a service-worker restart.
 * The `trigger` field is derived from `source` for back-compat with older UI/
 * storage versions.
 */
export interface FinishedRunInput {
  runId: string
  taskId?: string
  label?: string
  source: 'chat' | 'schedule' | 'feishu' | 'manual'
  startedAt?: number
  finishedAt?: number
  outcome: TaskRunOutcome
  summary?: string
  error?: string
  steps?: TaskRunStep[]
}

export async function recordFinishedRun(input: FinishedRunInput): Promise<TaskRunLog> {
  const list = await listRuns()
  const trigger: TaskRunLog['trigger'] =
    input.source === 'feishu' ? 'feishu' : input.source === 'manual' ? 'manual' : 'schedule'
  const entry: TaskRunLog = {
    id: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
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
    ...(input.steps && input.steps.length > 0 ? { steps: input.steps } : {}),
  }
  // If a placeholder/earlier record with the same id exists, replace it.
  const existing = list.findIndex((r) => r.id === input.runId)
  if (existing !== -1) list[existing] = entry
  else list.unshift(entry)
  await chrome.storage.local.set({ [KEY_RUNS]: list.slice(0, MAX_RUN_LOGS) })
  return entry
}

export async function clearRuns(taskId?: string): Promise<void> {
  if (!taskId) {
    await chrome.storage.local.set({ [KEY_RUNS]: [] })
    return
  }
  const list = await listRuns()
  await chrome.storage.local.set({ [KEY_RUNS]: list.filter((run) => run.taskId !== taskId) })
}

/** Deletes a single run-log entry by its id. */
export async function deleteRun(id: string): Promise<void> {
  const list = await listRuns()
  await chrome.storage.local.set({ [KEY_RUNS]: list.filter((run) => run.id !== id) })
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
  const stored = await chrome.storage.local.get(KEY_FEISHU)
  return asFeishu(stored[KEY_FEISHU])
}

export async function saveFeishuConfig(config: FeishuConfig): Promise<FeishuConfig> {
  const normalized = asFeishu(config)
  await chrome.storage.local.set({ [KEY_FEISHU]: normalized })
  return normalized
}
