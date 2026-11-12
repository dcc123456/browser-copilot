/**
 * Tasks tab: create/edit scheduled tasks and configure Feishu delivery.
 *
 * This is the control surface for the scheduler running in the service worker.
 * All persistence goes through `sendCommand`; the worker owns alarms and the
 * Feishu connection, so saving here both stores and re-arms everything.
 *
 * Live progress and the run-history log live in the History tab's activity
 * board (see `RunningBoard.tsx`); this tab manages task definitions and, while
 * a task runs, swaps its Run button for a terminate control.
 *
 * @module sidepanel/TasksTab
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { sendCommand } from '../lib/messages'
import { STORAGE_RECONNECTED_EVENT } from '../lib/fs-reconnect'
import { onStoreChanged } from '../lib/store-events'
import { createDraft } from '../lib/task-store'
import { describeSchedule, schedulesOf } from '../lib/schedule'
import type { FeishuConfig, ScheduledTask } from '../lib/scheduler-types'
import type { Workflow } from '../lib/workflow/types'
import TaskEditDialog from './TaskEditDialog'
import { useRowHighlight } from './hooks/useRowHighlight'
import { useRunningTasks } from './hooks/useRunningTasks'
import { useT } from './i18n'
import Banner from './components/Banner'
import { confirmDialog } from '../ui/confirm'
import { Switch } from '../ui/Switch'
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui/button-styles'

/** Editable form state. */
type Draft = ScheduledTask

/**
 * Result line of a Feishu action. The panel renders it in place, next to the
 * control that produced it, rather than in the page-level banner far above the
 * folded section.
 */
type FeishuOutcome = { kind: 'ok' | 'error'; text: string }

/**
 * Whether anything is actually wired up. Shared by the collapsed summary and
 * the card badge so the two can never disagree.
 */
function isFeishuConfigured(config: FeishuConfig): boolean {
  const webhook = config.webhookUrl.trim() !== ''
  const bot = config.appId.trim() !== '' && config.appSecret.trim() !== ''
  return webhook || (config.botEnabled && bot)
}

function emptyTask(): Draft {
  // Every new task is a free-form agent prompt. The built-in GitHub review task
  // is created/edited from its own entry; the editor does not need a type picker
  // because the prompt is what the user actually writes.
  return createDraft({
    name: '',
    kind: 'agent-prompt',
    schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 10, minute: 0 },
    prompt: '',
    notifyFeishu: false,
  })
}

export default function TasksTab() {
  const t = useT()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [feishu, setFeishu] = useState<FeishuConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** Flash the row just saved, or the one the tokens board deep-linked to. */
  const { highlightedId, flash } = useRowHighlight('bc:open-task', 'data-task-id')
  // Runs started from a schedule, Feishu, or this tab register the configured
  // task id, so each card can terminate its own run without opening History.
  const { running, cancellingIds, cancel } = useRunningTasks()
  const runningByTask = useMemo(() => {
    const byTask = new Map<string, string[]>()
    for (const run of running) {
      if (!run.taskId) continue
      const ids = byTask.get(run.taskId)
      if (ids) ids.push(run.runId)
      else byTask.set(run.taskId, [run.runId])
    }
    return byTask
  }, [running])
  const terminateTaskRuns = useCallback(
    async (taskId: string): Promise<void> => {
      for (const runId of runningByTask.get(taskId) ?? []) {
        await cancel(runId)
      }
    },
    [runningByTask, cancel],
  )

  const load = useCallback(async () => {
    try {
      const [taskResult, feishuResult, workflowResult] = await Promise.all([
        sendCommand({ type: 'tasks.list' }),
        sendCommand({ type: 'feishu.get' }),
        sendCommand({ type: 'workflows.list' }),
      ])
      if (taskResult.type === 'tasks.list') setTasks(taskResult.tasks)
      if (feishuResult.type === 'feishu.get') setFeishu(feishuResult.config)
      if (workflowResult.type === 'workflows.list') setWorkflows(workflowResult.workflows)
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Storage reconnects itself on the panel's first interaction after an
  // extension update (lib/fs-reconnect). Tasks/feishu/workflow lists were read
  // while the handle was still unavailable — reload them the moment the
  // folder is back instead of waiting for a panel restart.
  useEffect(() => {
    const handler = (): void => {
      void load()
    }
    window.addEventListener(STORAGE_RECONNECTED_EVENT, handler)
    return () => window.removeEventListener(STORAGE_RECONNECTED_EVENT, handler)
  }, [load])

  // Auto-refresh when tasks are created or edited elsewhere — from a chat turn
  // (`create_scheduled_task`), by the worker's alarm run recording its result,
  // or by another window's panel. Every panel tab stays mounted (App.tsx), so
  // without this the list would only show the tasks as of the panel opening.
  // Same contract as the workflows tab: file-backed storage announces its own
  // writes through `lib/store-events` instead of `chrome.storage.onChanged`.
  useEffect(() => onStoreChanged('scheduledTasks', () => void load()), [load])

  const persistTask = async (task: Draft): Promise<void> => {
    setBusy(true)
    // Close the dialog immediately so the click always gives visible
    // feedback, even if the worker is slow or the command ultimately fails.
    // The save itself runs in the background and surfaces an error banner on
    // failure; optimistically marking the id highlights the card on success.
    const savedId = task.id
    setDraft(null)
    flash(savedId)
    try {
      await sendCommand({ type: 'tasks.save', task })
      setBanner({ kind: 'ok', text: t.taskSaved })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const removeTask = async (id: string): Promise<void> => {
    // Deleting a chain parent also clears its run log, so every child silently
    // loses its input forever — say so before the click, not after.
    const followers = tasks.filter((entry) => entry.followsTaskId === id).map((entry) => entry.name)
    const ok = await confirmDialog({
      title: t.dialogDeleteTitle,
      message: followers.length
        ? `${t.taskDeleteConfirm}\n${t.taskDeleteChained({ names: followers.join(', ') })}`
        : t.taskDeleteConfirm,
      confirmText: t.delete,
      cancelText: t.cancel,
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await sendCommand({ type: 'tasks.delete', id })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await sendCommand({ type: 'tasks.run', id })
      if (result.type === 'tasks.run') {
        setBanner({
          kind: result.outcome.ok ? 'ok' : 'error',
          text: result.outcome.summary || result.outcome.error || t.taskStatusFailed,
        })
      }
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const saveFeishu = async (config: FeishuConfig): Promise<FeishuOutcome> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'feishu.save', config })
      setFeishu(config)
      return { kind: 'ok', text: t.tasksFeishuSaved }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    } finally {
      setBusy(false)
    }
  }

  const testFeishu = async (): Promise<FeishuOutcome> => {
    if (!feishu) return { kind: 'error', text: t.tasksFeishuTestFailed }
    setBusy(true)
    try {
      // Save first so the worker tests the values the user just typed.
      await sendCommand({ type: 'feishu.save', config: feishu })
      const result = await sendCommand({ type: 'feishu.test' })
      if (result.type === 'feishu.test') {
        return result.ok
          ? { kind: 'ok', text: t.tasksFeishuTestOk }
          : { kind: 'error', text: result.message ?? t.tasksFeishuTestFailed }
      }
      return { kind: 'error', text: t.tasksFeishuTestFailed }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    } finally {
      setBusy(false)
    }
  }

  const locale = navigator.language
  const zh = locale.toLowerCase().startsWith('zh')

  return (
    <div className="pane tasks-tab">
      <h2>{t.tasksTitle}</h2>

      {banner && (
        <Banner kind={banner.kind} onDismiss={() => setBanner(null)}>
          {banner.text}
        </Banner>
      )}

      <div className="section-head">
        <h3>{t.tasksMine}</h3>
        {!draft && (
          <button
            className="primary section-action"
            disabled={busy}
            onClick={() => setDraft(emptyTask())}
            type="button"
          >
            + {t.taskNew}
          </button>
        )}
      </div>

      {draft && (
        <TaskEditDialog
          initial={draft}
          saving={busy}
          title={draft.name.trim() ? draft.name : t.taskNew}
          workflows={workflows}
          onCancel={() => setDraft(null)}
          onSave={(task) => void persistTask(task)}
        />
      )}

      {tasks.length === 0 ? (
        <div className="empty-state">
          <p>{t.tasksEmpty}</p>
        </div>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => {
            const schedules = schedulesOf(task)
            const manual = schedules.length === 0
            const activeRunIds = runningByTask.get(task.id) ?? []
            const isRunning = activeRunIds.length > 0
            const isCancelling = activeRunIds.some((runId) => cancellingIds.has(runId))
            return (
              <li
                className={`task-item${highlightedId === task.id ? ' task-item-saved' : ''}${
                  !task.enabled && !manual ? ' task-item-disabled' : ''
                }`}
                data-task-id={task.id}
                key={task.id}
              >
                <div className="task-item-head">
                  {manual ? (
                    // A manual task has no schedule to enable/disable; show its
                    // name plainly instead of an enable switch.
                    <strong className="task-item-name">{task.name}</strong>
                  ) : (
                    <Switch
                      checked={task.enabled}
                      disabled={busy || draft?.id === task.id}
                      label={<strong className="task-item-name">{task.name}</strong>}
                      onChange={(enabled) => void persistTask({ ...task, enabled })}
                    />
                  )}
                  <span className={`task-status task-status-${task.lastStatus ?? 'none'}`}>
                    {task.lastStatus === 'ok'
                      ? t.taskStatusOk
                      : task.lastStatus === 'failed'
                        ? t.taskStatusFailed
                        : task.lastStatus === 'skipped'
                          ? t.taskStatusSkipped
                          : ''}
                  </span>
                </div>
                <div className="task-meta">
                  {schedules.length === 0 ? (
                    <span className="task-chip task-chip-manual">
                      {describeSchedule({ kind: 'none' }, zh ? 'zh' : 'en', Date.now())}
                    </span>
                  ) : (
                    // One chip per trigger method: each one fires a run, so the
                    // list must not hide a second cadence behind the first.
                    schedules.map((schedule, index) => (
                      <span className="task-chip" key={index}>
                        {describeSchedule(schedule, zh ? 'zh' : 'en', Date.now())}
                      </span>
                    ))
                  )}
                  <span className="task-chip">
                    {task.kind === 'github-review-requests'
                      ? t.taskKindGithub
                      : task.kind === 'workflow'
                        ? t.taskKindWorkflow
                        : t.taskKindPrompt}
                  </span>
                  {task.followsTaskId && (
                    <span className="task-chip">
                      {t.taskFollows}:{' '}
                      {tasks.find((entry) => entry.id === task.followsTaskId)?.name ??
                        task.followsTaskId}
                    </span>
                  )}
                  {!!task.outputs?.length && (
                    <span className="task-chip">
                      {t.taskOutputs}: {task.outputs.join(', ')}
                    </span>
                  )}
                  {!!task.chainId && (
                    <span className="task-chip">
                      {t.taskChain}: {task.chainId}
                    </span>
                  )}
                  {task.notifyFeishu && <span className="task-chip task-chip-feishu">Feishu</span>}
                  {isRunning && <span className="task-chip text-accent!">{t.tasksRunning}</span>}
                </div>
                {task.lastRunAt && (
                  <div className="task-lastrun">
                    {t.taskLastRun}: {new Date(task.lastRunAt).toLocaleString(locale)}
                    {task.lastSummary ? ` — ${task.lastSummary.split('\n')[0]}` : ''}
                  </div>
                )}
                <div className="actions task-actions">
                  {isRunning ? (
                    <button
                      className="danger"
                      // Run-now keeps `busy` set until the run settles, so the
                      // terminate control must ignore it and only block its own
                      // in-flight cancel.
                      disabled={isCancelling}
                      onClick={() => void terminateTaskRuns(task.id)}
                      title={t.taskTerminate}
                      type="button"
                    >
                      {isCancelling ? t.taskCancelling : t.taskTerminate}
                    </button>
                  ) : (
                    <button
                      className="task-action-run"
                      disabled={busy || !!draft}
                      onClick={() => void runNow(task.id)}
                      type="button"
                    >
                      {t.taskRunNow}
                    </button>
                  )}
                  <button
                    disabled={busy || !!draft}
                    onClick={() => setDraft({ ...task })}
                    type="button"
                  >
                    {t.edit}
                  </button>
                  <button
                    className="danger"
                    disabled={busy || !!draft}
                    onClick={() => void removeTask(task.id)}
                    type="button"
                  >
                    {t.delete}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {feishu && (
        <details className="collapsible">
          <summary>
            <span className="collapsible-title">{t.tasksFeishuSection}</span>
            {/* The panel is folded by default, so the summary has to say
                whether anything is wired up at all. */}
            <ConfiguredBadge configured={isFeishuConfigured(feishu)} />
          </summary>
          <FeishuSection
            config={feishu}
            disabled={busy}
            onChange={setFeishu}
            onSave={saveFeishu}
            onTest={testFeishu}
          />
        </details>
      )}
    </div>
  )
}

// --- Feishu section ----------------------------------------------------------

function FeishuSection({
  config,
  disabled,
  onChange,
  onSave,
  onTest,
}: {
  config: FeishuConfig
  disabled: boolean
  onChange: (config: FeishuConfig) => void
  onSave: (config: FeishuConfig) => Promise<FeishuOutcome>
  onTest: () => Promise<FeishuOutcome>
}) {
  const t = useT()
  /** Which of this card's own actions is in flight; `disabled` is tab-wide. */
  const [pending, setPending] = useState<'save' | 'test' | null>(null)
  /** Outcome of the last action, shown next to the controls that caused it. */
  const [notice, setNotice] = useState<FeishuOutcome | null>(null)
  const [revealSecret, setRevealSecret] = useState(false)

  const busy = disabled || pending !== null
  // One save for the whole card: both groups write the same config object, so
  // a button per group only let one of them claim to have saved the other.
  const canSave =
    config.webhookUrl !== '' ||
    config.webhookSecret !== '' ||
    config.appId !== '' ||
    config.appSecret !== '' ||
    config.botEnabled

  const submit = async (
    kind: 'save' | 'test',
    action: () => Promise<FeishuOutcome>,
  ): Promise<void> => {
    if (busy) return
    setPending(kind)
    setNotice(null)
    try {
      setNotice(await action())
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="font-semibold text-ink">{t.tasksFeishuTitle}</span>
        <ConfiguredBadge configured={isFeishuConfigured(config)} />
      </div>

      {/* --- Outgoing webhook --- */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel-2 p-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-semibold text-ink">{t.tasksFeishuWebhookGroup}</span>
          <span className="text-[11px] leading-relaxed text-muted">
            {t.tasksFeishuWebhookGroupHint}
          </span>
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-ink">
          <span>{t.tasksFeishuWebhook}</span>
          <input
            disabled={busy}
            onChange={(event) => onChange({ ...config, webhookUrl: event.target.value })}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
            value={config.webhookUrl}
          />
        </label>
        <div className="flex flex-col gap-1 text-[12px] text-ink">
          <label className="flex flex-col gap-1" htmlFor="feishu-webhook-secret">
            <span>{t.tasksFeishuWebhookSecret}</span>
            <input
              disabled={busy}
              id="feishu-webhook-secret"
              onChange={(event) => onChange({ ...config, webhookSecret: event.target.value })}
              type={revealSecret ? 'text' : 'password'}
              value={config.webhookSecret}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input
              checked={revealSecret}
              className="w-auto!"
              disabled={busy}
              onChange={(event) => setRevealSecret(event.target.checked)}
              type="checkbox"
            />
            {t.tasksFeishuReveal}
          </label>
          <span className="text-[11px] leading-relaxed text-muted">{t.tasksFeishuSecretHint}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            className={SECONDARY_BUTTON}
            disabled={busy || config.webhookUrl === ''}
            onClick={() => void submit('test', onTest)}
            type="button"
          >
            {pending === 'test' ? t.tasksFeishuTesting : t.tasksFeishuTest}
          </button>
        </div>
      </div>

      {/* --- Inbound bot --- */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel-2 p-2.5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-ink">{t.tasksFeishuBotGroup}</span>
          <Switch
            checked={config.botEnabled}
            disabled={busy}
            label={t.tasksFeishuBot}
            onChange={(botEnabled) => onChange({ ...config, botEnabled })}
          />
        </div>
        {config.botEnabled && (
          <>
            <label className="flex flex-col gap-1 text-[12px] text-ink">
              <span>{t.tasksFeishuAppId}</span>
              <input
                disabled={busy}
                onChange={(event) => onChange({ ...config, appId: event.target.value })}
                value={config.appId}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink">
              <span>{t.tasksFeishuAppSecret}</span>
              <input
                disabled={busy}
                onChange={(event) => onChange({ ...config, appSecret: event.target.value })}
                type="password"
                value={config.appSecret}
              />
            </label>
            <p className="text-[11px] leading-relaxed text-muted">{t.tasksFeishuBotHint}</p>
            <div className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-warn">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
              <span>
                <strong className="font-semibold">{t.tasksFeishuWarnTitle}</strong>{' '}
                {t.tasksFeishuBotWarn}
              </span>
            </div>
          </>
        )}
      </div>

      {notice && (
        <div
          className={[
            'break-words rounded-lg px-3 py-2 text-[12px] leading-relaxed',
            notice.kind === 'ok'
              ? 'border border-ok/30 bg-ok-surface text-ok'
              : 'border border-err bg-err-surface text-err',
          ].join(' ')}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button
          className={PRIMARY_BUTTON}
          disabled={busy || !canSave}
          onClick={() => void submit('save', () => onSave(config))}
          type="button"
        >
          {pending === 'save' ? t.tasksFeishuSaving : t.save}
        </button>
      </div>
    </div>
  )
}

/** 'Configured' / 'Not configured' chip, shared by the summary and the card. */
function ConfiguredBadge({ configured }: { configured: boolean }) {
  const t = useT()
  return (
    <span
      className={[
        'rounded-full border px-2 py-0.5 text-[11px]',
        configured ? 'border-ok/30 bg-ok-surface text-ok' : 'border-border bg-panel-2 text-muted',
      ].join(' ')}
    >
      {configured ? t.tasksFeishuConfigured : t.tasksFeishuNotConfigured}
    </span>
  )
}
