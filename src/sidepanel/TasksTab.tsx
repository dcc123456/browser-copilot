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
import { sendCommand } from '../lib/messages'
import { createDraft } from '../lib/task-store'
import { describeSchedule } from '../lib/schedule'
import type { FeishuConfig, ScheduledTask, TaskRunLog } from '../lib/scheduler-types'
import { useT } from './i18n'

/** Editable form state. */
type Draft = ScheduledTask

function emptyTask(kind: ScheduledTask['kind'] = 'github-review-requests'): Draft {
  return createDraft({
    name: kind === 'github-review-requests' ? 'PRs to review' : '',
    kind,
    schedule: { kind: 'daily', hour: 10, minute: 0 },
    prompt: '',
    notifyFeishu: false,
  })
}

export default function TasksTab() {
  const t = useT()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [runs, setRuns] = useState<TaskRunLog[]>([])
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

  const persistTask = async (task: Draft): Promise<void> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'tasks.save', task })
      // Collapse the editor back into the list. The list reloads below, which
      // surfaces the saved task as a card; we also remember its id so the card
      // can flash to draw the user's eye.
      setDraft(null)
      setJustSavedId(task.id)
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
      <p className="hint">{t.tasksSubtitle}</p>

      {banner && (
        <div className={`banner banner-${banner.kind}`} role="status">
          {banner.text}
        </div>
      )}

      {!draft && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => setDraft(emptyTask('github-review-requests'))}
          type="button"
        >
          + {t.taskNew}
        </button>
      )}

      {draft && (
        <TaskEditor
          draft={draft}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onSave={persistTask}
          disabled={busy}
        />
      )}

      <ul className="task-list">
        {tasks.map((task) => (
          <li
            className={`task-item${justSavedId === task.id ? ' task-item-saved' : ''}`}
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
                <strong>{task.name}</strong>
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
              {describeSchedule(task.schedule, zh ? 'zh' : 'en')} ·{' '}
              {task.kind === 'github-review-requests' ? t.taskKindGithub : t.taskKindPrompt}
            </div>
            {task.lastRunAt && (
              <div className="task-meta">
                {t.taskLastRun}: {new Date(task.lastRunAt).toLocaleString(locale)}
                {task.lastSummary ? ` — ${task.lastSummary.split('\n')[0]}` : ''}
              </div>
            )}
            <div className="actions">
              <button disabled={busy || !!draft} onClick={() => void runNow(task.id)} type="button">
                {t.taskRunNow}
              </button>
              <button disabled={busy || !!draft} onClick={() => setDraft({ ...task })} type="button">
                {t.edit}
              </button>
              <button
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

      {feishu && (
        <FeishuSection
          config={feishu}
          disabled={busy}
          onChange={setFeishu}
          onSave={saveFeishu}
          onTest={testFeishu}
        />
      )}

      <RunLog runs={runs.slice(0, 20)} onClear={() => void sendCommand({ type: 'tasks.runs.clear' }).then(load)} />
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
          onChange={(event) => update('name', event.target.value)}
          value={draft.name}
        />
      </label>

      <label className="field">
        <span>{t.taskKind}</span>
        <select
          disabled={disabled}
          onChange={(event) =>
            update('kind', event.target.value as ScheduledTask['kind'])
          }
          value={draft.kind}
        >
          <option value="github-review-requests">{t.taskKindGithub}</option>
          <option value="agent-prompt">{t.taskKindPrompt}</option>
        </select>
      </label>

      {draft.kind === 'agent-prompt' && (
        <label className="field">
          <span>{t.taskPrompt}</span>
          <textarea
            disabled={disabled}
            onChange={(event) => update('prompt', event.target.value)}
            placeholder={t.taskPromptHint}
            rows={4}
            value={draft.prompt ?? ''}
          />
        </label>
      )}

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
  if (runs.length === 0) return null
  const triggerLabel = (trigger: TaskRunLog['trigger']): string =>
    trigger === 'feishu' ? t.taskTriggerFeishu : trigger === 'manual' ? t.taskTriggerManual : t.taskTriggerSchedule
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t.taskRuns}</h3>
        <button className="link" onClick={onClear} type="button">
          {t.taskRunsClear}
        </button>
      </div>
      <ul className="run-log">
        {runs.map((run) => (
          <li className={`run-line run-${run.ok ? 'ok' : run.skipped ? 'skipped' : 'err'}`} key={run.id}>
            <span className="run-time">{new Date(run.at).toLocaleString(navigator.language)}</span>
            <span className="run-tag">{triggerLabel(run.trigger)}</span>
            <span className="run-summary">{run.summary || run.error || ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
