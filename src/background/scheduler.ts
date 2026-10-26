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
 * A task may hold several trigger methods, and each one fires its own alarm:
 * `task:<id>` / `workflow:<id>` for the first entry (the historical name, so
 * alarms armed by an older build keep firing) and `…:<id>#<index>` for the
 * rest. On startup we reconcile alarms with stored tasks: tasks without an
 * alarm get one, and stale alarms (deleted tasks, shortened lists) are cleared.
 * This is idempotent, so calling `rescheduleAll` after every change is safe.
 *
 * @module background/scheduler
 */

import { nextRunAt, schedulesOf, withSchedules } from '../lib/schedule'
import { getTask, listTasks, disableTask, saveTask } from '../lib/task-store'
import type { Schedule, ScheduledTask } from '../lib/scheduler-types'
import { runTask } from './task-runner'

const ALARM_PREFIX = 'task:'
const WORKFLOW_ALARM_PREFIX = 'workflow:'
/** `chrome.alarms` rejects periods and delays under 1 minute. */
const MIN_ALARM_DELAY_MS = 60_000
/** Ids never contain it, so the trailing index is unambiguous. */
const INDEX_SEPARATOR = '#'

/**
 * Alarm name for one trigger method of a task. Index 0 deliberately keeps the
 * unsuffixed historical name.
 */
function alarmNameFor(task: ScheduledTask, index = 0): string {
  const base =
    task.kind === 'workflow' ? `${WORKFLOW_ALARM_PREFIX}${task.id}` : `${ALARM_PREFIX}${task.id}`
  return index === 0 ? base : `${base}${INDEX_SEPARATOR}${index}`
}

/**
 * Splits one of this scheduler's alarm names into the task it belongs to and
 * the index of the trigger method that fired.
 */
export function parseTaskAlarmName(name: string): { taskId: string; index: number } | null {
  const rest = name.startsWith(WORKFLOW_ALARM_PREFIX)
    ? name.slice(WORKFLOW_ALARM_PREFIX.length)
    : name.startsWith(ALARM_PREFIX)
      ? name.slice(ALARM_PREFIX.length)
      : ''
  if (!rest) return null
  const separator = rest.lastIndexOf(INDEX_SEPARATOR)
  if (separator === -1) return { taskId: rest, index: 0 }
  const taskId = rest.slice(0, separator)
  const indexText = rest.slice(separator + 1)
  if (!taskId || !/^\d+$/.test(indexText)) return null
  return { taskId, index: Number(indexText) }
}

export function taskIdFromAlarmName(name: string): string | null {
  return parseTaskAlarmName(name)?.taskId ?? null
}

/** Drops every alarm of one task, at any index and either prefix. */
async function clearTaskAlarms(taskId: string): Promise<void> {
  const alarms = await chrome.alarms.getAll()
  for (const alarm of alarms) {
    if (parseTaskAlarmName(alarm.name)?.taskId === taskId) await chrome.alarms.clear(alarm.name)
  }
}

/** Arms one trigger method, or clears the slot when it has no next firing. */
async function armSchedule(task: ScheduledTask, schedule: Schedule, index: number): Promise<void> {
  const name = alarmNameFor(task, index)
  const when = nextRunAt(schedule, Date.now())
  // null also means a one-shot whose instant is gone: leave it unarmed rather
  // than clamping it to "soon", which would re-fire a run that already happened.
  if (when === null) {
    await chrome.alarms.clear(name)
    return
  }
  // Alarms enforce a ~1 minute minimum; clamp and remember that we did. A delay
  // below the minimum is rejected outright with "Error during alarms.create".
  const safeWhen = Math.max(when, Date.now() + MIN_ALARM_DELAY_MS)
  await chrome.alarms.create(name, { when: safeWhen })
}

/**
 * Re-arms one task from scratch: clears the alarms it held (the list may have
 * shrunk, or the kind changed prefix) and arms one alarm per trigger method.
 * Disabled and manual tasks end up with no alarms.
 */
export async function scheduleTask(taskId: string): Promise<void> {
  const task = await getTask(taskId)
  await clearTaskAlarms(taskId)
  if (!task || !task.enabled) return
  const schedules = schedulesOf(task)
  for (let index = 0; index < schedules.length; index++) {
    await armSchedule(task, schedules[index]!, index)
  }
}

/** Clears and recreates alarms for every task, removing orphaned alarms. */
export async function rescheduleAll(): Promise<void> {
  // Clear anything that no longer corresponds to a known, enabled task first, so
  // a deleted task cannot fire later. Orphaned alarms are swept for BOTH the
  // plain-task and workflow prefixes.
  const existing = await chrome.alarms.getAll()
  const tasks = await listTasks()
  const knownIds = new Set(tasks.filter((task) => task.enabled).map((task) => task.id))

  for (const alarm of existing) {
    const parsed = parseTaskAlarmName(alarm.name)
    // An index this task no longer has is handled by its own scheduleTask call
    // below, which sweeps every alarm the task holds before arming it again.
    if (parsed && !knownIds.has(parsed.taskId)) {
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
  const parsed = parseTaskAlarmName(alarm.name)
  if (!parsed) return
  void handleScheduledRun(parsed.taskId, parsed.index)
}

async function handleScheduledRun(taskId: string, index: number): Promise<void> {
  const task = await getTask(taskId)
  if (!task || !task.enabled) return
  const schedules = schedulesOf(task)
  const schedule = schedules[index]
  // A stale alarm from a shortened list: the save path sweeps it, so there is
  // nothing here to fire.
  if (!schedule) return

  // A one-shot is finished the moment it fires, so it is put away BEFORE running
  // rather than re-armed after: if the run throws, or the worker is evicted
  // mid-run, nothing is left to fire it a second time.
  if (schedule.kind === 'once') {
    const remaining = schedules.filter((_, i) => i !== index)
    if (remaining.length === 0) {
      // `disableTask` goes through the store's key lock (the run about to settle
      // writes the same record), and `rescheduleAll` only knows enabled tasks,
      // so this one stays down.
      await disableTask(taskId)
      await chrome.alarms.clear(alarmNameFor(task, index))
      await runTask(task, 'schedule')
      return
    }
    // Other trigger methods still fire, so the task stays enabled; only the
    // spent entry goes. Removing it shifts the indices of everything after it,
    // which is why the whole shortened list is re-armed.
    const next = withSchedules(task, remaining)
    await saveTask(next)
    await scheduleTask(taskId)
    await runTask(next, 'schedule')
    return
  }

  // Recurring: the alarm is one-shot; queue THIS entry's next firing before
  // running so a crash in the task cannot strand it and firing one method does
  // not push another method's next run forward.
  await armSchedule(task, schedule, index)
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
