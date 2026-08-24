/**
 * Executes one scheduled task.
 *
 * This is the layer that turns "the clock struck 10" / "Feishu said run it" into
 * actual work, a logged result, and a notification. It is deliberately thin:
 * each kind of task has a focused implementation, and the cross-cutting concerns
 * (logging, notification, last-run state) live here so the per-task code can stay
 * about its job.
 *
 * @module background/task-runner
 */

import { effectiveLocale } from '../lib/i18n'
import {
  NotLoggedIn,
  fetchReviewRequests,
  formatReviewSummary,
} from '../lib/github'
import { sendWebhookText } from '../lib/feishu'
import type { ScheduledTask } from '../lib/scheduler-types'
import {
  addRun,
  getFeishuConfig,
  recordTaskRun,
} from '../lib/task-store'
import { runUnattendedPrompt } from './agent-unattended'
import { retain, release } from './keepalive'
import {
  addStep,
  finishRun,
  startRun,
  type RunningTask,
  type RunOutcomeKind,
} from './running-tasks'

export type TaskTrigger = 'schedule' | 'feishu' | 'manual'

export interface RunOutcome {
  ok: boolean
  skipped: boolean
  summary: string
  error?: string
  cancelled?: boolean
}

/**
 * Runs a task end to end.
 *
 * Holds the worker alive for the duration: an alarm wake gives the worker a few
 * hundred ms of headroom, and a task may take seconds (opening a tab, calling a
 * model). The matching `release` is in `finally`.
 *
 * Registers itself in the running-tasks board so the Tasks tab can show progress
 * and terminate it. For agent tasks, each tool step is recorded there (and
 * streamed to Feishu by the bot when triggered from chat).
 */
export async function runTask(
  task: ScheduledTask,
  trigger: TaskTrigger,
  locale?: string,
  feishuChatId?: string,
): Promise<RunOutcome> {
  retain()
  const lang = locale ?? effectiveLocale('auto', navigator.language)

  const source = trigger === 'feishu' ? 'feishu' : trigger === 'manual' ? 'manual' : 'schedule'
  const tracked = startRun({
    label: task.name,
    source,
    taskId: task.id,
    ...(feishuChatId ? { feishuChatId } : {}),
  })

  let outcome: RunOutcome = { ok: false, skipped: false, summary: '' }
  try {
    outcome = await executeTask(task, lang, tracked)
  } catch (error) {
    outcome = {
      ok: false,
      skipped: false,
      summary: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
    const boardOutcome: RunOutcomeKind = outcome.cancelled
      ? 'cancelled'
      : outcome.skipped
        ? 'skipped'
        : outcome.ok
          ? 'ok'
          : 'failed'
    finishRun(tracked.runId, {
      outcome: boardOutcome,
      summary: outcome.summary?.split('\n')[0] || outcome.error,
    })
  }

  // Record the run and update the task's last-run state. These are independent
  // of notification: a run exists even if Feishu is misconfigured. A cancelled
  // run is not recorded as a failure (it was intentional), but the last-run
  // state still reflects it so the UI does not look stale.
  if (!outcome.cancelled) {
    await addRun({
      taskId: task.id,
      trigger,
      ok: outcome.ok,
      skipped: outcome.skipped,
      summary: outcome.summary,
      error: outcome.error,
    })
    await recordTaskRun(task.id, {
      lastStatus: outcome.skipped ? 'skipped' : outcome.ok ? 'ok' : 'failed',
      lastSummary: outcome.summary,
      lastError: outcome.error,
    })
  }

  if (task.notifyFeishu && outcome.summary && !outcome.cancelled) {
    // Notify failures too: a silently broken daily report is worse than an error
    // message. NotLoggedIn already reads as an instruction to the user.
    await notifyOutcome(task, outcome, lang)
  }

  return outcome
}

async function executeTask(
  task: ScheduledTask,
  lang: string,
  tracked: RunningTask,
): Promise<RunOutcome> {
  addStep(tracked.runId, 'info', task.kind === 'github-review-requests' ? 'Fetching GitHub review requests…' : 'Starting agent task…')
  switch (task.kind) {
    case 'github-review-requests':
      return runReviewRequests(lang, tracked)
    case 'agent-prompt':
      return runAgentPrompt(task, lang, tracked)
    default: {
      // Exhaustiveness guard: a future task kind that isn't wired up fails
      // loudly rather than silently doing nothing. Cast through string so this
      // remains valid even with one union member at present.
      throw new Error(`Unknown task kind: ${String((task as { kind: string }).kind)}`)
    }
  }
}

async function runReviewRequests(lang: string, tracked: RunningTask): Promise<RunOutcome> {
  try {
    const result = await fetchReviewRequests()
    const { headline, body } = formatReviewSummary(result, lang)
    const summary = [headline, body].filter(Boolean).join('\n')
    // Surface the full report on the running/finished board so it can be
    // expanded after the run completes, not just in the persistent run log.
    for (const line of summary.split('\n').filter(Boolean)) {
      addStep(tracked.runId, 'result', line)
    }
    return { ok: true, skipped: false, summary }
  } catch (error) {
    if (error instanceof NotLoggedIn) {
      // The user asked for this exact behaviour: if the session is gone, skip
      // rather than fail with a stack trace. It still records and notifies so the
      // missing report is not invisible.
      const summary =
        lang.toLowerCase().startsWith('zh')
          ? '⏸ 未登录 GitHub，本次定时任务已跳过。请打开 github.com 重新登录。'
          : '⏸ Not logged in to GitHub; this run was skipped. Sign in at github.com.'
      addStep(tracked.runId, 'status', summary)
      return { ok: false, skipped: true, summary, error: error.message }
    }
    throw error
  }
}

/**
 * Runs a free-form prompt through the agent.
 *
 * Captures streamed text into a buffer because the task has no panel to stream
 * to. There is no `confirm` callback: a scheduled run happens unattended, so
 * every confirmation would time out. The agent runs in the user's configured
 * mode, but `semi` (per-action approval) effectively degrades to refusal for
 * actions — that is the safe default for unattended work. The user must opt into
 * `full` mode for acting tasks.
 */
async function runAgentPrompt(task: ScheduledTask, _lang: string, tracked: RunningTask): Promise<RunOutcome> {
  const prompt = task.prompt?.trim()
  if (!prompt) {
    return { ok: false, skipped: false, summary: '', error: 'This task has no prompt.' }
  }

  // Scheduled tasks honor the user's configured autonomy mode; they do not force
  // full mode the way an explicit Feishu command does. The abort signal lets the
  // board terminate a runaway run, and each step is recorded for the UI / Feishu.
  const result = await runUnattendedPrompt(prompt, `task:${task.id}`, undefined, {
    signal: tracked.controller.signal,
    onStep: (kind, text) => addStep(tracked.runId, kind, text),
  })
  return {
    ok: result.ok,
    skipped: false,
    summary: result.answer,
    error: result.error,
    cancelled: result.cancelled,
  }
}

async function notifyOutcome(task: ScheduledTask, outcome: RunOutcome, lang: string): Promise<void> {
  const config = await getFeishuConfig()
  if (!config.webhookUrl) return
  const title = lang.toLowerCase().startsWith('zh') ? `🤖 任务：${task.name}` : `🤖 Task: ${task.name}`
  const text = `${title}\n${outcome.summary}${
    outcome.error && !outcome.summary.toLowerCase().includes('sign in') && !outcome.summary.includes('登录')
      ? `\n\n${outcome.error}`
      : ''
  }`
  try {
    await sendWebhookText(config.webhookUrl, text, config.webhookSecret)
  } catch (error) {
    // Notification failure must not make the run itself look failed — the work
    // already happened. Surface it in the run log, but do not throw.
    const message = error instanceof Error ? error.message : String(error)
    await addRun({
      taskId: task.id,
      trigger: 'manual',
      ok: false,
      skipped: false,
      summary: `Feishu notification failed: ${message}`,
    })
  }
}
