/**
 * Scheduled-task create/edit dialog — replaces the inline editor card that used
 * to expand above the task list, so editing a task never pushes the page around.
 *
 * The dialog owns the draft fields (an edit must be free to hold an incomplete
 * schedule while the user types); persistence stays with the caller: `onSave`
 * receives the whole draft, the caller validates, saves through the worker and
 * closes. Same split as `sidepanel/SkillEditDialog`.
 *
 * @module sidepanel/TaskEditDialog
 */
import { useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { describeSchedule } from '../lib/schedule'
import type { ScheduledTask } from '../lib/scheduler-types'
import type { Workflow } from '../lib/workflow/types'
import { useT } from './i18n'
import NumberInput from '../ui/NumberInput'
import { Switch } from '../ui/Switch'

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

interface Props {
  /** Starting values; the dialog remounts per open so no sync effect is needed. */
  initial: Draft
  /** Heading: the task name (edit) or "New task" (create). */
  title: string
  workflows: Workflow[]
  /** True while the caller persists — disables the buttons, prevents double submits. */
  saving: boolean
  onSave: (task: Draft) => void
  onCancel: () => void
}

export default function TaskEditDialog({
  initial,
  title,
  workflows,
  saving,
  onSave,
  onCancel,
}: Props): React.ReactElement {
  const t = useT()
  const [task, setTask] = useState<Draft>(initial)
  const zh = navigator.language.toLowerCase().startsWith('zh')
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setTask((prev) => ({ ...prev, [key]: value }))

  // Only the agent-prompt and workflow kinds are configurable in the editor;
  // the built-in GitHub review task is managed through its own entry.
  const kind = task.kind === 'workflow' ? 'workflow' : 'agent-prompt'
  const selectKind = (next: 'agent-prompt' | 'workflow'): void => {
    if (kind === next) return
    setTask((prev) => ({
      ...prev,
      kind: next,
      // Clear the field that no longer applies when switching kinds.
      ...(next === 'workflow' ? { prompt: undefined } : { workflowId: undefined }),
    }))
  }

  const WEEKDAYS = [1, 2, 3, 4, 5]
  const WEEKEND = [6, 0]
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

  // The editor exposes three "when" modes:
  //  - "manual": no automatic run (no alarm), triggered by hand / Feishu;
  //  - "weekly": covers the old "daily" and "weekdays" presets via the day chips;
  //  - "interval": repeat every N minutes.
  // Older tasks stored as daily/weekdays are mapped to weekly for display and
  // migrate back to weekly on save.
  const isManual = task.schedule.kind === 'none'
  const sched =
    task.schedule.kind === 'none'
      ? ({ kind: 'none' } as const)
      : task.schedule.kind === 'daily'
        ? {
            kind: 'weekly' as const,
            days: ALL_DAYS,
            hour: task.schedule.hour,
            minute: task.schedule.minute,
          }
        : task.schedule.kind === 'weekdays'
          ? {
              kind: 'weekly' as const,
              days: WEEKDAYS,
              hour: task.schedule.hour,
              minute: task.schedule.minute,
            }
          : task.schedule

  const isTimeBased = sched.kind === 'weekly'
  const timeHour = isTimeBased ? sched.hour : 9
  const timeMinute = isTimeBased ? sched.minute : 0
  const pad2 = (n: number): string => n.toString().padStart(2, '0')
  const timeValue = `${pad2(timeHour)}:${pad2(timeMinute)}`
  const setTime = (hour: number, minute: number): void => {
    if (sched.kind !== 'weekly') return
    setTask((prev) => ({ ...prev, schedule: { ...sched, hour, minute } }))
  }
  const onTimeChange = (value: string): void => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return
    setTime(
      Math.min(23, Math.max(0, Number(match[1]))),
      Math.min(59, Math.max(0, Number(match[2]))),
    )
  }

  // A one-shot is stored as an epoch but edited as the wall-clock instant the
  // user means, which is exactly what `datetime-local` holds (no zone suffix):
  // reading it back with `new Date()` therefore parses as local time.
  const toLocalStamp = (ms: number): string => {
    const when = new Date(ms)
    return (
      `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}` +
      `T${pad2(when.getHours())}:${pad2(when.getMinutes())}`
    )
  }
  const onceValue = sched.kind === 'once' ? toLocalStamp(sched.at) : ''
  const setOnce = (value: string): void => {
    const at = new Date(value).getTime()
    if (!Number.isFinite(at)) return
    update('schedule', { kind: 'once', at })
  }

  const setDays = (days: number[]): void => {
    if (sched.kind !== 'weekly') return
    const sorted = Array.from(new Set(days)).sort((a, b) => a - b)
    setTask((prev) => ({ ...prev, schedule: { ...sched, days: sorted } }))
  }
  const toggleDay = (day: number): void => {
    if (sched.kind !== 'weekly') return
    const has = sched.days.includes(day)
    // Keep at least one day selected so the schedule is never empty.
    if (has && sched.days.length === 1) return
    setDays(has ? sched.days.filter((d) => d !== day) : [...sched.days, day])
  }

  const canSave = task.name.trim().length > 0 && (task.kind !== 'workflow' || !!task.workflowId)

  return (
    <FormDialog
      footer={
        <>
          <FormDialogCancelButton disabled={saving} label={t.cancel} onClick={onCancel} />
          <FormDialogPrimaryButton
            disabled={saving || !canSave}
            label={t.taskSave}
            onClick={() => onSave(task)}
          />
        </>
      }
      onClose={onCancel}
      title={title}
      width="lg"
    >
      <div className="task-editor">
        <label className="field">
          <span>{t.taskName}</span>
          <input
            disabled={saving}
            onChange={(event) => update('name', event.target.value)}
            value={task.name}
          />
        </label>

        <fieldset className="field kind-field">
          <legend>{t.taskKind}</legend>
          <div className="seg-control" role="radiogroup">
            {(
              [
                { kind: 'agent-prompt', label: t.taskKindPrompt },
                { kind: 'workflow', label: t.taskKindWorkflow },
              ] as const
            ).map((opt) => (
              <label className={`seg-btn${kind === opt.kind ? ' seg-btn-on' : ''}`} key={opt.kind}>
                <input
                  checked={kind === opt.kind}
                  disabled={saving}
                  onChange={() => selectKind(opt.kind)}
                  type="radio"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind === 'workflow' ? (
          <label className="field">
            <span>{t.taskWorkflow}</span>
            <select
              disabled={saving || workflows.length === 0}
              onChange={(event) => update('workflowId', event.target.value || undefined)}
              value={task.workflowId ?? ''}
            >
              <option value="">{t.taskWorkflowPlaceholder}</option>
              {workflows.map((wf) => (
                <option key={wf.id} value={wf.id}>
                  {wf.name}
                </option>
              ))}
            </select>
            <p className="hint">{t.taskWorkflowHint}</p>
          </label>
        ) : (
          <label className="field">
            <span>{t.taskPrompt}</span>
            <textarea
              disabled={saving}
              onChange={(event) => update('prompt', event.target.value)}
              placeholder={t.taskPromptHint}
              rows={5}
              value={task.prompt ?? ''}
            />
          </label>
        )}

        <fieldset className="field schedule-field">
          <legend>{t.taskSchedule}</legend>
          <div className="seg-control" role="radiogroup">
            {(
              [
                { kind: 'none', label: t.taskSchedManual },
                { kind: 'weekly', label: t.taskSchedWeekly },
                { kind: 'once', label: t.taskSchedOnce },
                { kind: 'interval', label: t.taskSchedInterval },
              ] as const
            ).map((opt) => (
              <label
                className={`seg-btn${sched.kind === opt.kind ? ' seg-btn-on' : ''}`}
                key={opt.kind}
              >
                <input
                  checked={sched.kind === opt.kind}
                  disabled={saving}
                  onChange={() => {
                    if (opt.kind === 'none') {
                      // A manual task never fires on a clock, so there is nothing
                      // to enable/disable — keep it stored as enabled.
                      setTask({ ...task, enabled: true, schedule: { kind: 'none' } })
                      return
                    }
                    if (opt.kind === 'interval') {
                      update('schedule', { kind: 'interval', minutes: 60 })
                      return
                    }
                    if (opt.kind === 'once') {
                      // Defaults to the next full hour so the task is armable the
                      // moment it is switched; the instant the picker holds is what
                      // actually fires.
                      const when = new Date()
                      when.setMinutes(0, 0, 0)
                      when.setHours(when.getHours() + 1)
                      update('schedule', { kind: 'once', at: when.getTime() })
                      return
                    }
                    const hour =
                      sched.kind === 'weekly' ? sched.hour : sched.kind === 'interval' ? 9 : 9
                    const minute = sched.kind === 'weekly' ? sched.minute : 0
                    const days =
                      sched.kind === 'weekly' && sched.days.length > 0 ? sched.days : WEEKDAYS
                    update('schedule', { kind: 'weekly', days, hour, minute })
                  }}
                  type="radio"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>

          {sched.kind === 'none' && (
            <div className="manual-block">
              <div className="schedule-preview" aria-live="polite">
                {describeSchedule(sched, zh ? 'zh' : 'en')}
              </div>
              <p className="hint">{t.taskManualHint}</p>
            </div>
          )}

          {sched.kind === 'weekly' && (
            <div className="weekly-block">
              <div className="day-chips">
                {WEEKDAY_OPTIONS.map((day) => {
                  const checked = sched.days.includes(day.value)
                  return (
                    <button
                      aria-pressed={checked}
                      className={`day-chip${checked ? ' day-chip-on' : ''}`}
                      disabled={saving}
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
                <button disabled={saving} onClick={() => setDays(WEEKDAYS)} type="button">
                  {t.taskDaysWeekdays}
                </button>
                <button disabled={saving} onClick={() => setDays(WEEKEND)} type="button">
                  {t.taskDaysWeekend}
                </button>
                <button disabled={saving} onClick={() => setDays(ALL_DAYS)} type="button">
                  {t.taskDaysAll}
                </button>
              </div>
            </div>
          )}

          {sched.kind === 'once' && (
            <div className="schedule-config">
              <label className="time-input">
                <input
                  disabled={saving}
                  onChange={(event) => setOnce(event.target.value)}
                  type="datetime-local"
                  value={onceValue}
                />
              </label>
              <p className="hint">{t.taskOnceHint}</p>
            </div>
          )}

          {(sched.kind === 'weekly' || sched.kind === 'interval') && (
            <div className="schedule-config">
              {sched.kind === 'weekly' ? (
                <label className="time-input">
                  <input
                    disabled={saving}
                    onChange={(event) => onTimeChange(event.target.value)}
                    type="time"
                    value={timeValue}
                  />
                </label>
              ) : (
                <label className="interval-input">
                  <NumberInput
                    disabled={saving}
                    min={1}
                    value={sched.minutes}
                    onChange={(n) => update('schedule', { kind: 'interval', minutes: n })}
                  />
                  <span>{t.taskMinutes}</span>
                </label>
              )}
            </div>
          )}

          {sched.kind !== 'none' && (
            <div className="schedule-preview" aria-live="polite">
              {describeSchedule(sched, zh ? 'zh' : 'en', Date.now())}
            </div>
          )}
        </fieldset>

        <div className="option-row">
          <label className="option-field">
            <span>{t.taskMaxRounds}</span>
            <NumberInput
              disabled={saving}
              max={500}
              min={1}
              value={task.maxToolRounds}
              onChange={(n) => update('maxToolRounds', n)}
            />
          </label>
          <label className="inline-check">
            <input
              checked={task.notifyFeishu}
              onChange={(event) => update('notifyFeishu', event.target.checked)}
              type="checkbox"
            />
            {t.taskNotifyFeishu}
          </label>
          {!isManual && (
            <Switch
              checked={task.enabled}
              label={t.taskEnabled}
              onChange={(enabled) => update('enabled', enabled)}
            />
          )}
        </div>
        <p className="hint option-hint">{t.taskMaxRoundsHint}</p>
      </div>
    </FormDialog>
  )
}
