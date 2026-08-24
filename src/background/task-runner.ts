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

export type TaskTrigger = 'schedule' | 'feishu' | 'manual'

export interface RunOutcome {
  ok: boolean
  skipped: boolean
  summary: string
  error?: string
}

/**
 * Runs a task end to end.
 *
 * Holds the worker alive for the duration: an alarm wake gives the worker a few
 * hundred ms of headroom, and a task may take seconds (opening a tab, calling a
 * model). The matching `release` is in `finally`.
 */
export async function runTask(
  task: ScheduledTask,
  trigger: TaskTrigger,
  locale?: string,
): Promise<RunOutcome> {
  retain()
  const lang = locale ?? effectiveLocale('auto', navigator.language)
  let outcome: RunOutcome

  try {
    outcome = await executeTask(task, lang)
  } catch (error) {
    outcome = {
      ok: false,
      skipped: false,
      summary: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
  }

  // Record the run and update the task's last-run state. These are independent
  // of notification: a run exists even if Feishu is misconfigured.
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

  if (task.notifyFeishu && outcome.summary) {
    // Notify failures too: a silently broken daily report is worse than an error
    // message. NotLoggedIn already reads as an instruction to the user.
    await notifyOutcome(task, outcome, lang)
  }

  return outcome
}

async function executeTask(task: ScheduledTask, lang: string): Promise<RunOutcome> {
  switch (task.kind) {
    case 'github-review-requests':
      return runReviewRequests(lang)
    case 'agent-prompt':
      return runAgentPrompt(task, lang)
    default: {
      // Exhaustiveness guard: a future task kind that isn't wired up fails
      // loudly rather than silently doing nothing. Cast through string so this
      // remains valid even with one union member at present.
      throw new Error(`Unknown task kind: ${String((task as { kind: string }).kind)}`)
    }
  }
}

async function runReviewRequests(lang: string): Promise<RunOutcome> {
  try {
    const result = await fetchReviewRequests()
    const { headline, body } = formatReviewSummary(result, lang)
    return {
      ok: true,
      skipped: false,
      summary: [headline, body].filter(Boolean).join('\n'),
    }
  } catch (error) {
    if (error instanceof NotLoggedIn) {
      // The user asked for this exact behaviour: if the session is gone, skip
      // rather than fail with a stack trace. It still records and notifies so the
      // missing report is not invisible.
      const summary =
        lang.toLowerCase().startsWith('zh')
          ? '⏸ 未登录 GitHub，本次定时任务已跳过。请打开 github.com 重新登录。'
          : '⏸ Not logged in to GitHub; this run was skipped. Sign in at github.com.'
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
async function runAgentPrompt(task: ScheduledTask, _lang: string): Promise<RunOutcome> {
  const prompt = task.prompt?.trim()
  if (!prompt) {
    return { ok: false, skipped: false, summary: '', error: 'This task has no prompt.' }
  }

  // Scheduled tasks honor the user's configured autonomy mode; they do not force
  // full mode the way an explicit Feishu command does.
  const result = await runUnattendedPrompt(prompt, `task:${task.id}`)
  return {
    ok: result.ok,
    skipped: false,
    summary: result.answer,
    error: result.error,
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
