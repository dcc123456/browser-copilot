/**
 * Alarm scheduling for tasks.
 *
 * ## Why one-shot alarms, not periodic
 *
 * `chrome.alarms` supports a repeating `periodInMinutes`, but it cannot express
 * "weekdays only" or "at 10:00 local time" (a fixed period drifts across
 * timezones and DST). So every task uses a **one-shot** alarm computed for its
 * next local firing; when it fires, the handler runs the task and reschedules the
 * following one. This trades a tiny bit of bookkeeping for correctness.
 *
 * ## Alarm name contract
 *
 * Alarm names are `task:<id>`, and `workflow:<id>` for workflow-kind tasks. On
 * startup we reconcile alarms with stored tasks: tasks without an alarm get one,
 * and stale alarms (deleted tasks) are cleared. This is idempotent, so calling
 * `rescheduleAll` after every change is safe.
 *
 * @module background/scheduler
 */

import { nextRunAt } from '../lib/schedule'
import { getTask, listTasks, saveTask } from '../lib/task-store'
import type { ScheduledTask } from '../lib/scheduler-types'
import { runTask } from './task-runner'

const ALARM_PREFIX = 'task:'
const WORKFLOW_ALARM_PREFIX = 'workflow:'
/** `chrome.alarms` rejects periods and delays under 1 minute. */
const MIN_ALARM_DELAY_MS = 60_000

/** Legacy name for a task alarm; workflow-kind tasks use the `workflow:` prefix. */
function alarmName(taskId: string): string {
  return `${ALARM_PREFIX}${taskId}`
}

/**
 * Alarm name for a specific task, chosen by its kind so workflow tasks can be
 * told apart (and orphan-cleared) independently from plain scheduled tasks.
 */
function alarmNameFor(task: ScheduledTask): string {
  return task.kind === 'workflow'
    ? `${WORKFLOW_ALARM_PREFIX}${task.id}`
    : `${ALARM_PREFIX}${task.id}`
}

export function taskIdFromAlarmName(name: string): string | null {
  if (name.startsWith(WORKFLOW_ALARM_PREFIX)) return name.slice(WORKFLOW_ALARM_PREFIX.length)
  if (name.startsWith(ALARM_PREFIX)) return name.slice(ALARM_PREFIX.length)
  return null
}

/**
 * Creates or replaces the alarm for one task. Disabled tasks have their alarm
 * cleared (but are kept, so they can be re-enabled).
 */
export async function scheduleTask(taskId: string): Promise<void> {
  const task = await getTask(taskId)
  // Fall back to the legacy `task:` prefix when the task cannot be found, so a
  // deleted task's alarm is still cleared by the caller's reschedule.
  const name = task ? alarmNameFor(task) : alarmName(taskId)
  if (!task || !task.enabled) {
    await chrome.alarms.clear(name)
    return
  }
  const when = nextRunAt(task.schedule, Date.now())
  // Alarms enforce a ~1 minute minimum; clamp and remember that we did. A delay
  // below the minimum is rejected outright with "Error during alarms.create".
  const safeWhen = Math.max(when, Date.now() + MIN_ALARM_DELAY_MS)
  await chrome.alarms.create(name, { when: safeWhen })
}

/** Clears and recreates alarms for every task, removing orphaned alarms. */
export async function rescheduleAll(): Promise<void> {
  // Clear anything that no longer corresponds to a known, enabled task first, so
  // a deleted task cannot fire later. Orphaned alarms are swept for BOTH the
  // plain-task and workflow prefixes.
  const existing = await chrome.alarms.getAll()
  const tasks = await listTasks()
  const known = new Set(
    tasks.filter((task) => task.enabled).map((task) => alarmNameFor(task)),
  )

  for (const alarm of existing) {
    const isOurs =
      alarm.name.startsWith(ALARM_PREFIX) || alarm.name.startsWith(WORKFLOW_ALARM_PREFIX)
    if (isOurs && !known.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name)
    }
  }
  for (const task of tasks) {
    // scheduleTask itself handles enabled/disabled; schedule for all so a
    // re-enabled task is immediately armed.
    await scheduleTask(task.id)
  }
}

/**
 * Alarm handler. Must be registered at the worker top level so a worker woken by
 * an alarm receives the event.
 */
export function onAlarm(alarm: chrome.alarms.Alarm): void {
  const taskId = taskIdFromAlarmName(alarm.name)
  if (!taskId) return
  void handleScheduledRun(taskId)
}

async function handleScheduledRun(taskId: string): Promise<void> {
  const task = await getTask(taskId)
  if (!task || !task.enabled) return

  // The alarm is one-shot; queue the next firing before running so a crash in
  // the task does not leave the schedule stranded.
  await scheduleTask(taskId)
  await runTask(task, 'schedule')
}

/**
 * Runs a task immediately (from the UI or Feishu), without disturbing its
 * regular schedule. Returns the runner's outcome. When triggered from Feishu,
 * pass the chat id so per-step progress can be streamed back to that chat.
 */
export async function triggerNow(
  taskId: string,
  trigger: 'manual' | 'feishu' = 'manual',
  feishuChatId?: string,
) {
  const task = await getTask(taskId)
  if (!task) throw new Error('Task not found.')
  return runTask(task, trigger, undefined, feishuChatId)
}

// Re-exported so callers can record "just ran" without importing the store
// directly. Kept for symmetry with the old scheduler's touch operation.
export { saveTask }
