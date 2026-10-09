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
import { NotLoggedIn, fetchReviewRequests, formatReviewSummary } from '../lib/github'
import { sendWebhookText } from '../lib/feishu'
import type { ScheduledTask, TaskRunLog } from '../lib/scheduler-types'
import { addRun, getFeishuConfig, getTask, listRuns, recordTaskRun } from '../lib/task-store'
import {
  buildUpstream,
  clampHandoffBag,
  describeUnresolved,
  resolveTaskInputs,
} from '../lib/task-chain'
import { runUnattendedPrompt } from './agent-unattended'
import { resolveUnattendedScope } from './window-policy'
import { retain, release } from './keepalive'
import { getWorkflow } from '../lib/workflow/storage'
import { observeFirstRunOfRevision } from '../lib/workflow/replay-metrics'
import { executeWorkflow } from './workflow-engine/run-workflow'
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
  /**
   * Named values this run hands to the task that follows it, already clamped to
   * the handoff budget. Persisted onto the run record so the child can resolve
   * `{{upstream.*}}` in a later worker.
   */
  outputs?: Record<string, unknown>
}

/**
 * A task's stored inputs after `{{upstream.*}}` has been answered — what to run
 * now that the chain has been read.
 */
interface ResolvedInputs {
  prompt?: string
  variables?: Record<string, unknown>
}

/**
 * Reads the chain a task sits on: resolve its references against the parent's
 * last successful run, or explain why it must not run yet.
 *
 * Two shapes of "cannot run", deliberately different. A parent that has not
 * produced a successful run is a TIMING gap — the chain is merely early (a
 * comment task armed before the note was published), so this run is skipped and
 * the schedule gets another chance, touching no page. A parent that no longer
 * exists, or that ran fine but never carried the key being read, can never fix
 * itself: that fails loudly and names what the parent DID produce.
 */
async function resolveChain(
  task: ScheduledTask,
  lang: string,
): Promise<{ inputs: ResolvedInputs; blocked?: RunOutcome }> {
  const zh = lang.toLowerCase().startsWith('zh')
  const parentId = task.followsTaskId
  let parentName = ''
  let parentRun: TaskRunLog | undefined

  if (parentId) {
    const parent = await getTask(parentId)
    if (!parent) {
      const error = zh
        ? `本任务依赖的定时任务已不存在（${parentId}）。请重建链条，或清除该依赖。`
        : `The scheduled task this one follows no longer exists (${parentId}). Re-create the chain, or clear the dependency.`
      return { inputs: {}, blocked: { ok: false, skipped: false, summary: '', error } }
    }
    parentName = parent.name
    parentRun = (await listRuns(parentId)).find((run) => run.outcome === 'ok')
  }

  const upstream = buildUpstream(parentRun)
  const resolved = resolveTaskInputs(task, upstream)
  if (resolved.unresolved.tokens.length === 0) {
    // The parent's bag is also seeded INTO the run, so a graph node can read
    // `{{upstream.noteUrl}}` for itself instead of depending on the task's own
    // `variables` to have copied each value out.
    const variables =
      parentId && Object.keys(upstream).length > 0
        ? { ...(resolved.variables ?? {}), upstream }
        : resolved.variables
    return {
      inputs: {
        prompt: resolved.prompt,
        ...(variables ? { variables } : {}),
      },
    }
  }

  if (!parentRun) {
    const waiting = parentName
      ? zh
        ? `⏸ 等待上游：本任务需要「${parentName}」成功运行后产出的值，但它还没有产出。本次已跳过。`
        : `⏸ Waiting upstream: this task needs values from a successful run of 「${parentName}」, which has produced none. Skipped.`
      : zh
        ? `⏸ 本任务引用了 {{upstream.*}}，但没有关联任何上游任务，无法取值。本次已跳过。`
        : `⏸ This task references {{upstream.*}} but follows no scheduled task, so there is nothing to read. Skipped.`
    return { inputs: {}, blocked: { ok: false, skipped: true, summary: waiting } }
  }

  const error = describeUnresolved(resolved.unresolved, parentName, parentRun)
  return { inputs: {}, blocked: { ok: false, skipped: false, summary: '', error } }
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
    const chain = await resolveChain(task, lang)
    if (chain.blocked) {
      // The chain never started: no tab opened, no prompt sent. The reason is a
      // step on the run, so the history shows why this entry is empty.
      const reason = chain.blocked.error ?? chain.blocked.summary
      if (reason) addStep(tracked.runId, chain.blocked.skipped ? 'status' : 'error', reason)
      outcome = chain.blocked
    } else {
      outcome = await executeTask(task, lang, tracked, chain.inputs)
    }
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
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.outputs ? { outputs: outcome.outputs } : {}),
    })
  }

  // Update the task's last-run state. The run itself (with its steps) is
  // persisted by finishRun via the registered persister; a cancelled run is not
  // recorded as a failure (it was intentional) but the last-run state still
  // reflects it so the UI does not look stale.
  if (!outcome.cancelled) {
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

/**
 * Opening run-log line for a task. Each kind gets its own wording: a workflow
 * task that announced "Starting agent task…" read as if the agent were about to
 * act, which made the missing workflow steps look like a broken run.
 */
function taskStartLine(task: ScheduledTask): string {
  switch (task.kind) {
    case 'github-review-requests':
      return 'Fetching GitHub review requests…'
    case 'workflow':
      return 'Starting workflow task…'
    default:
      return 'Starting agent task…'
  }
}

async function executeTask(
  task: ScheduledTask,
  lang: string,
  tracked: RunningTask,
  inputs: ResolvedInputs,
): Promise<RunOutcome> {
  addStep(tracked.runId, 'info', taskStartLine(task))
  switch (task.kind) {
    case 'github-review-requests':
      return runReviewRequests(lang, tracked)
    case 'agent-prompt':
      return runAgentPrompt(task, inputs, lang, tracked)
    case 'workflow':
      return runWorkflowTask(task, inputs, lang, tracked)
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
    const result = await fetchReviewRequests(tracked.controller.signal)
    const { headline, body } = formatReviewSummary(result, lang)
    const summary = [headline, body].filter(Boolean).join('\n')
    // Surface the full report on the running/finished board so it can be
    // expanded after the run completes, not just in the persistent run log.
    for (const line of summary.split('\n').filter(Boolean)) {
      addStep(tracked.runId, 'result', line)
    }
    return { ok: true, skipped: false, summary }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return { ok: false, skipped: false, cancelled: true, summary: '' }
    }
    if (error instanceof NotLoggedIn) {
      // The user asked for this exact behaviour: if the session is gone, skip
      // rather than fail with a stack trace. It still records and notifies so the
      // missing report is not invisible.
      const summary = lang.toLowerCase().startsWith('zh')
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
 * every confirmation would time out. Scheduled/manual/Feishu task runs all use
 * FULL mode — the task is an explicit "go do this", and a hidden confirmation
 * that can never be answered would make every acting task fail. Each task
 * carries its own tool-round budget (default 50) so long unattended workflows
 * aren't bounded by the interactive setting.
 */
async function runAgentPrompt(
  task: ScheduledTask,
  inputs: ResolvedInputs,
  _lang: string,
  tracked: RunningTask,
): Promise<RunOutcome> {
  // `inputs.prompt` is the task's own prompt with any `{{upstream.*}}` answered;
  // an unchained task keeps its text untouched.
  const prompt = (inputs.prompt ?? task.prompt)?.trim()
  if (!prompt) {
    return { ok: false, skipped: false, summary: '', error: 'This task has no prompt.' }
  }

  const result = await runUnattendedPrompt(prompt, `task:${task.id}`, 'full', {
    signal: tracked.controller.signal,
    maxToolRounds: task.maxToolRounds,
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

/**
 * Runs a scheduled workflow-kind task through the workflow engine. The engine
 * records its steps on the run this task already opened (`reuseRun`), so the
 * task's run log shows the whole workflow — one entry, not two.
 *
 * This is also where the chain is read and written: the task's resolved inputs
 * seed the run's variable bag (the engine lets a payload override the trigger's
 * defaults), and the run's final bag is filtered down to the names this task
 * declared as its outputs.
 */
async function runWorkflowTask(
  task: ScheduledTask,
  inputs: ResolvedInputs,
  lang: string,
  tracked: RunningTask,
): Promise<RunOutcome> {
  const zh = lang.toLowerCase().startsWith('zh')
  const workflow = task.workflowId ? await getWorkflow(task.workflowId) : undefined
  if (!workflow) {
    return { ok: false, skipped: false, summary: '', error: 'This task has no workflow.' }
  }
  addStep(tracked.runId, 'info', `Running workflow: ${workflow.name}`)
  // A scheduled workflow run is unattended: while the plugin runs anywhere
  // (panel connected or minimized) it acts inside that plugin window; with
  // the plugin closed everywhere it falls back to the legacy global chain.
  const scope = await resolveUnattendedScope()
  const outcome = await executeWorkflow(workflow, {
    // The real trigger, not a hardcoded 'schedule': a manual "Run now" (or a
    // Feishu command) on a workflow task must be labelled — and filed in the
    // run history — for what it actually was.
    source: tracked.source === 'chat' ? 'schedule' : tracked.source,
    taskId: task.id,
    feishuChatId: tracked.feishuChatId,
    reuseRun: tracked,
    ...(inputs.variables ? { variables: inputs.variables } : {}),
    ...(scope ? { scopeWindowId: scope.windowId } : {}),
  })
  // A successful run publishes exactly what it declared. An undeclared name is
  // reported on THIS run rather than failing it: the run did its job, and the
  // dependency only bites in the child that comes to read it — which fails
  // there, loudly, with this run's key list in the message.
  const declared = task.outputs ?? []
  for (const name of declared) {
    if (outcome.outcome === 'ok' && outcome.variables?.[name] === undefined) {
      const produced = Object.keys(outcome.variables ?? {})
        .slice(0, 8)
        .join(', ')
      addStep(
        tracked.runId,
        'error',
        zh
          ? `声明要交接的变量「${name}」在这次运行里没有产生${produced ? `（实际产生：${produced}）` : ''}，下游任务将无法取值。`
          : `Declared output "${name}" was never produced by this run${produced ? ` (it produced: ${produced})` : ''}; tasks following this one cannot read it.`,
      )
    }
  }
  // An unattended run is as much an exam for a generated graph as the panel's
  // Run button: without this, a workflow whose first replay came from a
  // schedule would be graded by whichever later run happened to be clicked.
  observeFirstRunOfRevision(workflow, {
    outcome: outcome.outcome,
    error: outcome.error,
    summary: outcome.summary,
    trace: outcome.trace,
    degradations: outcome.degradations,
  })
  const outputs =
    outcome.outcome === 'ok' ? clampHandoffBag(outcome.variables, declared) : undefined
  return {
    ok: outcome.outcome === 'ok',
    skipped: false,
    summary: outcome.summary ?? '',
    error: outcome.outcome === 'failed' ? (outcome.error ?? outcome.summary) : undefined,
    cancelled: outcome.outcome === 'cancelled',
    ...(outputs ? { outputs } : {}),
  }
}

async function notifyOutcome(
  task: ScheduledTask,
  outcome: RunOutcome,
  lang: string,
): Promise<void> {
  const config = await getFeishuConfig()
  if (!config.webhookUrl) return
  const title = lang.toLowerCase().startsWith('zh')
    ? `🤖 任务：${task.name}`
    : `🤖 Task: ${task.name}`
  const text = `${title}\n${outcome.summary}${
    outcome.error &&
    !outcome.summary.toLowerCase().includes('sign in') &&
    !outcome.summary.includes('登录')
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
