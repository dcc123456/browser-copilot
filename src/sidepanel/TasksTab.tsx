/**
 * Tasks tab: create/edit scheduled tasks and configure Feishu delivery.
 *
 * This is the control surface for the scheduler running in the service worker.
 * All persistence goes through `sendCommand`; the worker owns alarms and the
 * Feishu connection, so saving here both stores and re-arms everything.
 *
 * @module sidepanel/TasksTab
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand, type FinishedTaskView, type RunningTaskView } from '../lib/messages'
import { createDraft } from '../lib/task-store'
import { describeSchedule } from '../lib/schedule'
import type { FeishuConfig, ScheduledTask, TaskRunLog } from '../lib/scheduler-types'
import { useT } from './i18n'

/** Editable form state. */
type Draft = ScheduledTask

function emptyTask(): Draft {
  // Every new task is a free-form agent prompt. The built-in GitHub review task
  // is created/edited from its own entry; the editor does not need a type picker
  // because the prompt is what the user actually writes.
  return createDraft({
    name: '',
    kind: 'agent-prompt',
    schedule: { kind: 'daily', hour: 10, minute: 0 },
    prompt: '',
    notifyFeishu: false,
  })
}

export default function TasksTab() {
  const t = useT()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [runs, setRuns] = useState<TaskRunLog[]>([])
  const [running, setRunning] = useState<RunningTaskView[]>([])
  const [finished, setFinished] = useState<FinishedTaskView[]>([])
  const [feishu, setFeishu] = useState<FeishuConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** Id of the task just saved, so its card can briefly highlight. */
  const [justSavedId, setJustSavedId] = useState<string | null>(null)

  // Clear the highlight a short time after it appears, without re-running load.
  useEffect(() => {
    if (!justSavedId) return
    const timer = setTimeout(() => setJustSavedId(null), 1800)
    return () => clearTimeout(timer)
  }, [justSavedId])

  const load = useCallback(async () => {
    try {
      const [taskResult, runsResult, feishuResult] = await Promise.all([
        sendCommand({ type: 'tasks.list' }),
        sendCommand({ type: 'tasks.runs' }),
        sendCommand({ type: 'feishu.get' }),
      ])
      if (taskResult.type === 'tasks.list') setTasks(taskResult.tasks)
      if (runsResult.type === 'tasks.runs') setRuns(runsResult.runs)
      if (feishuResult.type === 'feishu.get') setFeishu(feishuResult.config)
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll the running-tasks board while the tab is mounted so progress steps and
  // start/finish appear live. The list is tiny and cheap to fetch; an interval
  // also survives the worker being evicted and restarted between polls.
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const result = await sendCommand({ type: 'tasks.running' })
        if (active && result.type === 'tasks.running') {
          setRunning(result.runs)
          setFinished(result.finished)
        }
      } catch {
        /* non-fatal; keep polling */
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const cancelRunning = async (runId: string): Promise<void> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'tasks.cancel', runId })
      // Refresh immediately; the aborted run moves to the completed list shortly.
      const result = await sendCommand({ type: 'tasks.running' })
      if (result.type === 'tasks.running') {
        setRunning(result.runs)
        setFinished(result.finished)
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  const persistTask = async (task: Draft): Promise<void> => {
    setBusy(true)
    // Collapse the editor immediately so the click always gives visible
    // feedback, even if the worker is slow or the command ultimately fails.
    // The save itself runs in the background and surfaces an error banner on
    // failure; optimistically marking the id highlights the card on success.
    const savedId = task.id
    setDraft(null)
    setJustSavedId(savedId)
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
    if (!confirm(t.taskDeleteConfirm)) return
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

  const saveFeishu = async (config: FeishuConfig): Promise<void> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'feishu.save', config })
      setFeishu(config)
      setBanner({ kind: 'ok', text: t.save })
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const testFeishu = async (): Promise<void> => {
    if (!feishu) return
    setBusy(true)
    try {
      // Save first so the worker tests the values the user just typed.
      await sendCommand({ type: 'feishu.save', config: feishu })
      const result = await sendCommand({ type: 'feishu.test' })
      if (result.type === 'feishu.test') {
        setBanner(
          result.ok
            ? { kind: 'ok', text: t.tasksFeishuTestOk }
            : { kind: 'error', text: result.message ?? 'failed' },
        )
      }
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
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
        <div className={`banner banner-${banner.kind}`} data-kind={banner.kind} role="status">
          {banner.text}
        </div>
      )}

      <RunningBoard
        running={running}
        finished={finished}
        onCancel={(id) => void cancelRunning(id)}
        busy={busy}
      />

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
        <TaskEditor
          draft={draft}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onSave={persistTask}
          disabled={busy}
        />
      )}

      {tasks.length === 0 && !draft ? (
        <div className="empty-state">
          <p>{t.tasksEmpty}</p>
        </div>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li
              className={`task-item${justSavedId === task.id ? ' task-item-saved' : ''}${
                !task.enabled ? ' task-item-disabled' : ''
              }`}
              key={task.id}
            >
              <div className="task-item-head">
                <label className="inline-check">
                  <input
                    checked={task.enabled}
                    disabled={busy || draft?.id === task.id}
                    onChange={(event) =>
                      void persistTask({ ...task, enabled: event.target.checked })
                    }
                    type="checkbox"
                  />
                  <strong className="task-item-name">{task.name}</strong>
                </label>
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
                <span className="task-chip">
                  {describeSchedule(task.schedule, zh ? 'zh' : 'en')}
                </span>
                <span className="task-chip">
                  {task.kind === 'github-review-requests' ? t.taskKindGithub : t.taskKindPrompt}
                </span>
                {task.notifyFeishu && <span className="task-chip task-chip-feishu">Feishu</span>}
              </div>
              {task.lastRunAt && (
                <div className="task-lastrun">
                  {t.taskLastRun}: {new Date(task.lastRunAt).toLocaleString(locale)}
                  {task.lastSummary ? ` — ${task.lastSummary.split('\n')[0]}` : ''}
                </div>
              )}
              <div className="actions task-actions">
                <button
                  className="task-action-run"
                  disabled={busy || !!draft}
                  onClick={() => void runNow(task.id)}
                  type="button"
                >
                  {t.taskRunNow}
                </button>
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
          ))}
        </ul>
      )}

      {feishu && (
        <details className="collapsible">
          <summary>
            <span className="collapsible-title">{t.tasksFeishuSection}</span>
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

      <details className="collapsible">
        <summary>
          <span className="collapsible-title">{t.tasksRunHistory}</span>
          {runs.length > 0 && <span className="collapsible-count">{runs.length}</span>}
        </summary>
        <RunLog
          runs={runs.slice(0, 20)}
          onClear={() => void sendCommand({ type: 'tasks.runs.clear' }).then(load)}
        />
      </details>
    </div>
  )
}

// --- Editor ------------------------------------------------------------------

function TaskEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  disabled,
}: {
  draft: Draft
  onChange: (task: Draft) => void
  onCancel: () => void
  onSave: (task: Draft) => void
  disabled: boolean
}) {
  const t = useT()
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    onChange({ ...draft, [key]: value })

  const sched = draft.schedule
  const setTime = (hour: number, minute: number): void => {
    if (sched.kind === 'interval') return
    onChange({ ...draft, schedule: { ...sched, hour, minute } })
  }

  const canSave = draft.name.trim().length > 0

  return (
    <div className="card task-editor">
      <label className="field">
        <span>{t.taskName}</span>
        <input
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </label>

      <label className="field">
        <span>{t.taskPrompt}</span>
        <textarea
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          placeholder={t.taskPromptHint}
          rows={5}
          value={draft.prompt ?? ''}
        />
      </label>

      <fieldset className="field">
        <legend>{t.taskSchedule}</legend>
        <div className="schedule-row">
          <label>
            <input
              checked={sched.kind === 'daily'}
              onChange={() =>
                update('schedule', {
                  kind: 'daily',
                  hour: sched.kind === 'interval' ? 9 : sched.hour,
                  minute: sched.kind === 'interval' ? 0 : sched.minute,
                })
              }
              type="radio"
            />{' '}
            {t.taskSchedDaily}
          </label>
          <label>
            <input
              checked={sched.kind === 'weekdays'}
              onChange={() =>
                update('schedule', {
                  kind: 'weekdays',
                  hour: sched.kind === 'interval' ? 9 : sched.hour,
                  minute: sched.kind === 'interval' ? 0 : sched.minute,
                })
              }
              type="radio"
            />{' '}
            {t.taskSchedWeekdays}
          </label>
          <label>
            <input
              checked={sched.kind === 'interval'}
              onChange={() => update('schedule', { kind: 'interval', minutes: 60 })}
              type="radio"
            />{' '}
            {t.taskSchedInterval}
          </label>
        </div>

        {sched.kind !== 'interval' ? (
          <div className="schedule-row">
            <input
              disabled={disabled}
              max={23}
              min={0}
              onChange={(event) =>
                setTime(Number(event.target.value), sched.minute)
              }
              type="number"
              value={sched.hour}
            />
            :
            <input
              disabled={disabled}
              max={59}
              min={0}
              onChange={(event) => setTime(sched.hour, Number(event.target.value))}
              type="number"
              value={sched.minute}
            />
          </div>
        ) : (
          <div className="schedule-row">
            <input
              disabled={disabled}
              min={1}
              onChange={(event) =>
                update('schedule', { kind: 'interval', minutes: Number(event.target.value) })
              }
              type="number"
              value={sched.minutes}
            />
            {t.taskMinutes}
          </div>
        )}
      </fieldset>

      <label className="inline-check">
        <input
          checked={draft.notifyFeishu}
          onChange={(event) => update('notifyFeishu', event.target.checked)}
          type="checkbox"
        />
        {t.taskNotifyFeishu}
      </label>

      <label className="inline-check">
        <input
          checked={draft.enabled}
          onChange={(event) => update('enabled', event.target.checked)}
          type="checkbox"
        />
        {t.taskEnabled}
      </label>

      <div className="actions">
        <button className="primary" disabled={disabled || !canSave} onClick={() => onSave(draft)} type="button">
          {t.taskSave}
        </button>
        <button disabled={disabled} onClick={onCancel} type="button">
          {t.cancel}
        </button>
      </div>
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
  onSave: (config: FeishuConfig) => void
  onTest: () => void
}) {
  const t = useT()
  const dirty =
    config.webhookUrl || config.appId || config.appSecret || config.webhookSecret
  return (
    <div className="card">
      <h3>{t.tasksFeishuTitle}</h3>

      <label className="field">
        <span>{t.tasksFeishuWebhook}</span>
        <input
          disabled={disabled}
          onChange={(event) => onChange({ ...config, webhookUrl: event.target.value })}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
          value={config.webhookUrl}
        />
      </label>
      <label className="field">
        <span>{t.tasksFeishuWebhookSecret}</span>
        <input
          disabled={disabled}
          onChange={(event) => onChange({ ...config, webhookSecret: event.target.value })}
          value={config.webhookSecret}
        />
      </label>
      <p className="hint">{t.tasksFeishuSecretHint}</p>

      <div className="actions">
        <button disabled={disabled || !dirty} onClick={() => void onSave(config)} type="button">
          {t.save}
        </button>
        <button disabled={disabled || !config.webhookUrl} onClick={onTest} type="button">
          {t.tasksFeishuTest}
        </button>
      </div>

      <hr />

      <label className="inline-check">
        <input
          checked={config.botEnabled}
          onChange={(event) => onChange({ ...config, botEnabled: event.target.checked })}
          type="checkbox"
        />
        <strong>{t.tasksFeishuBot}</strong>
      </label>
      {config.botEnabled && (
        <>
          <label className="field">
            <span>{t.tasksFeishuAppId}</span>
            <input
              disabled={disabled}
              onChange={(event) => onChange({ ...config, appId: event.target.value })}
              value={config.appId}
            />
          </label>
          <label className="field">
            <span>{t.tasksFeishuAppSecret}</span>
            <input
              disabled={disabled}
              onChange={(event) => onChange({ ...config, appSecret: event.target.value })}
              type="password"
              value={config.appSecret}
            />
          </label>
          <p className="hint">{t.tasksFeishuBotHint}</p>
          <p className="hint banner-error-inline">{t.tasksFeishuBotWarn}</p>
          <div className="actions">
            <button disabled={disabled} onClick={() => void onSave(config)} type="button">
              {t.save}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// --- Run log -----------------------------------------------------------------

function RunLog({ runs, onClear }: { runs: TaskRunLog[]; onClear: () => void }) {
  const t = useT()
  const triggerLabel = (trigger: TaskRunLog['trigger']): string =>
    trigger === 'feishu' ? t.taskTriggerFeishu : trigger === 'manual' ? t.taskTriggerManual : t.taskTriggerSchedule
  return (
    <div className="run-log-wrap">
      <div className="run-log-bar">
        <button className="link" onClick={onClear} type="button">
          {t.taskRunsClear}
        </button>
      </div>
      {runs.length === 0 ? (
        <p className="hint">{t.taskRunsEmpty}</p>
      ) : (
        <ul className="run-log">
          {runs.map((run) => (
            <li
              className={`run-line run-${run.ok ? 'ok' : run.skipped ? 'skipped' : 'err'}`}
              key={run.id}
            >
              <span className="run-time">{new Date(run.at).toLocaleString(navigator.language)}</span>
              <span className="run-tag">{triggerLabel(run.trigger)}</span>
              <span className="run-summary">{run.summary || run.error || ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- Running board -----------------------------------------------------------

function RunningBoard({
  running,
  finished,
  onCancel,
  busy,
}: {
  running: RunningTaskView[]
  finished: FinishedTaskView[]
  onCancel: (runId: string) => void
  busy: boolean
}) {
  const t = useT()
  const sourceLabel = (source: RunningTaskView['source']): string =>
    source === 'feishu'
      ? t.taskSourceFeishu
      : source === 'chat'
        ? t.taskSourceChat
        : source === 'manual'
          ? t.taskSourceManual
          : t.taskSourceSchedule
  const outcomeLabel = (outcome: FinishedTaskView['outcome']): string =>
    outcome === 'ok'
      ? t.taskOutcomeOk
      : outcome === 'cancelled'
        ? t.taskOutcomeCancelled
        : outcome === 'skipped'
          ? t.taskOutcomeSkipped
          : t.taskOutcomeFailed

  return (
    <div className={`card running-board${running.length > 0 ? ' running-board-active' : ''}`}>
      <div className="card-head">
        <h3>
          {running.length > 0 && <span className="running-dot" />}
          {t.tasksActivity}
          {running.length > 0 && <span className="running-count">{running.length}</span>}
        </h3>
      </div>

      {running.length === 0 ? (
        <p className="hint running-empty">{t.tasksRunningEmpty}</p>
      ) : (
        <ul className="running-list">
          {running.map((run) => (
            <li className="running-item" key={run.runId}>
              <div className="running-item-head">
                <strong className="running-label">{run.label || t.taskUntitled}</strong>
                <button
                  className="running-cancel"
                  disabled={busy}
                  onClick={() => onCancel(run.runId)}
                  type="button"
                >
                  {t.taskTerminate}
                </button>
              </div>
              <div className="running-meta">
                <span className="run-tag">{sourceLabel(run.source)}</span>
                <span>
                  {t.taskStartedAt}: {new Date(run.startedAt).toLocaleTimeString(navigator.language)}
                </span>
              </div>
              {run.steps.length > 0 && (
                <ul className="running-steps">
                  {run.steps.slice(-8).map((step, index) => (
                    <li className={`running-step running-step-${step.kind}`} key={index}>
                      {step.text}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {finished.length > 0 && (
        <>
          <div className="running-divider" />
          <h4 className="running-section-title">{t.tasksRecentlyFinished}</h4>
          <ul className="finished-list">
            {finished.slice(0, 8).map((run) => (
              <li className={`finished-row finished-${run.outcome}`} key={run.runId}>
                <span className={`finished-dot finished-dot-${run.outcome}`} />
                <span className="finished-name">{run.label || t.taskUntitled}</span>
                <span className="run-tag">{sourceLabel(run.source)}</span>
                <span className={`finished-badge finished-badge-${run.outcome}`}>
                  {outcomeLabel(run.outcome)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
