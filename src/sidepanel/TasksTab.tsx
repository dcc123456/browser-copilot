/**
 * Tasks tab: create/edit scheduled tasks and configure Feishu delivery.
 *
 * This is the control surface for the scheduler running in the service worker.
 * All persistence goes through `sendCommand`; the worker owns alarms and the
 * Feishu connection, so saving here both stores and re-arms everything.
 *
 * Live run progress and the run-history log now live in the History tab's
 * activity board (see `RunningBoard.tsx`); this tab only manages task
 * definitions.
 *
 * @module sidepanel/TasksTab
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../lib/messages'
import { createDraft } from '../lib/task-store'
import { describeSchedule } from '../lib/schedule'
import type { FeishuConfig, ScheduledTask } from '../lib/scheduler-types'
import { useT } from './i18n'

/** Editable form state. */
type Draft = ScheduledTask

/** Weekday checkboxes, Monday-first; values match Date.getDay() (Sun=0). */
const WEEKDAY_OPTIONS: { value: number; en: string; zh: string }[] = [
  { value: 1, en: 'Mon', zh: '周一' },
  { value: 2, en: 'Tue', zh: '周二' },
  { value: 3, en: 'Wed', zh: '周三' },
  { value: 4, en: 'Thu', zh: '周四' },
  { value: 5, en: 'Fri', zh: '周五' },
  { value: 6, en: 'Sat', zh: '周六' },
  { value: 0, en: 'Sun', zh: '周日' },
]

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
      const [taskResult, feishuResult] = await Promise.all([
        sendCommand({ type: 'tasks.list' }),
        sendCommand({ type: 'feishu.get' }),
      ])
      if (taskResult.type === 'tasks.list') setTasks(taskResult.tasks)
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
  const zh = navigator.language.toLowerCase().startsWith('zh')
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    onChange({ ...draft, [key]: value })

  const WEEKDAYS = [1, 2, 3, 4, 5]
  const WEEKEND = [6, 0]
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

  // The editor exposes just two kinds: "weekly" (which covers "daily" and the
  // old "weekdays" preset via the day chips/shortcuts) and "interval". Older
  // tasks stored as daily/weekdays are mapped to their weekly equivalents for
  // display, and any edit writes them back as weekly so they migrate on save.
  const sched =
    draft.schedule.kind === 'daily'
      ? { kind: 'weekly' as const, days: ALL_DAYS, hour: draft.schedule.hour, minute: draft.schedule.minute }
      : draft.schedule.kind === 'weekdays'
        ? { kind: 'weekly' as const, days: WEEKDAYS, hour: draft.schedule.hour, minute: draft.schedule.minute }
        : draft.schedule

  const isTimeBased = sched.kind !== 'interval'
  const timeHour = isTimeBased ? sched.hour : 9
  const timeMinute = isTimeBased ? sched.minute : 0
  const pad2 = (n: number): string => n.toString().padStart(2, '0')
  const timeValue = `${pad2(timeHour)}:${pad2(timeMinute)}`
  const setTime = (hour: number, minute: number): void => {
    if (sched.kind === 'interval') return
    onChange({ ...draft, schedule: { ...sched, hour, minute } })
  }
  const onTimeChange = (value: string): void => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return
    setTime(Math.min(23, Math.max(0, Number(match[1]))), Math.min(59, Math.max(0, Number(match[2]))))
  }

  const setDays = (days: number[]): void => {
    if (sched.kind !== 'weekly') return
    const sorted = Array.from(new Set(days)).sort((a, b) => a - b)
    onChange({ ...draft, schedule: { ...sched, days: sorted } })
  }
  const toggleDay = (day: number): void => {
    if (sched.kind !== 'weekly') return
    const has = sched.days.includes(day)
    // Keep at least one day selected so the schedule is never empty.
    if (has && sched.days.length === 1) return
    setDays(has ? sched.days.filter((d) => d !== day) : [...sched.days, day])
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

      <fieldset className="field schedule-field">
        <legend>{t.taskSchedule}</legend>
        <div className="seg-control" role="radiogroup">
          {(
            [
              { kind: 'weekly', label: t.taskSchedWeekly },
              { kind: 'interval', label: t.taskSchedInterval },
            ] as const
          ).map((opt) => (
            <label
              className={`seg-btn${sched.kind === opt.kind ? ' seg-btn-on' : ''}`}
              key={opt.kind}
            >
              <input
                checked={sched.kind === opt.kind}
                disabled={disabled}
                onChange={() => {
                  if (opt.kind === 'interval') {
                    update('schedule', { kind: 'interval', minutes: 60 })
                    return
                  }
                  const hour = sched.kind === 'interval' ? 9 : sched.hour
                  const minute = sched.kind === 'interval' ? 0 : sched.minute
                  const days =
                    sched.kind === 'weekly' && sched.days.length > 0
                      ? sched.days
                      : WEEKDAYS
                  update('schedule', { kind: 'weekly', days, hour, minute })
                }}
                type="radio"
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>

        {sched.kind === 'weekly' && (
          <div className="weekly-block">
            <div className="day-chips">
              {WEEKDAY_OPTIONS.map((day) => {
                const checked = sched.days.includes(day.value)
                return (
                  <button
                    aria-pressed={checked}
                    className={`day-chip${checked ? ' day-chip-on' : ''}`}
                    disabled={disabled}
                    key={day.value}
                    onClick={() => toggleDay(day.value)}
                    type="button"
                  >
                    {zh ? day.zh : day.en}
                  </button>
                )
              })}
            </div>
            <div className="day-quick">
              <button
                disabled={disabled}
                onClick={() => setDays(WEEKDAYS)}
                type="button"
              >
                {t.taskDaysWeekdays}
              </button>
              <button
                disabled={disabled}
                onClick={() => setDays(WEEKEND)}
                type="button"
              >
                {t.taskDaysWeekend}
              </button>
              <button
                disabled={disabled}
                onClick={() => setDays(ALL_DAYS)}
                type="button"
              >
                {t.taskDaysAll}
              </button>
            </div>
          </div>
        )}

        <div className="schedule-config">
          {isTimeBased ? (
            <label className="time-input">
              <input
                disabled={disabled}
                onChange={(event) => onTimeChange(event.target.value)}
                type="time"
                value={timeValue}
              />
            </label>
          ) : (
            <label className="interval-input">
              <input
                disabled={disabled}
                min={1}
                onChange={(event) =>
                  update('schedule', {
                    kind: 'interval',
                    minutes: Number(event.target.value) || 1,
                  })
                }
                type="number"
                value={sched.minutes}
              />
              <span>{t.taskMinutes}</span>
            </label>
          )}
        </div>

        <div className="schedule-preview" aria-live="polite">
          {describeSchedule(sched, zh ? 'zh' : 'en')}
        </div>
      </fieldset>

      <div className="option-row">
        <label className="option-field">
          <span>{t.taskMaxRounds}</span>
          <input
            disabled={disabled}
            max={500}
            min={1}
            onChange={(event) =>
              onChange({
                ...draft,
                maxToolRounds: Math.min(500, Math.max(1, Number(event.target.value) || 1)),
              })
            }
            type="number"
            value={draft.maxToolRounds}
          />
        </label>
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
      </div>
      <p className="hint option-hint">{t.taskMaxRoundsHint}</p>

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
