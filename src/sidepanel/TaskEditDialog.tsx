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
import { Trash2 } from 'lucide-react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import {
  describeSchedule,
  nextRunAt,
  normalizeCronExpression,
  schedulesOf,
  withSchedules,
} from '../lib/schedule'
import type { Schedule, ScheduledTask } from '../lib/scheduler-types'
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

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [6, 0]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** The shapes one trigger-method card can hold (no automatic method = no card). */
type EditorSchedule =
  | Extract<Schedule, { kind: 'weekly' }>
  | Extract<Schedule, { kind: 'once' }>
  | Extract<Schedule, { kind: 'interval' }>
  | Extract<Schedule, { kind: 'cron' }>

/**
 * Stored schedules render as one of the four card shapes. The legacy
 * daily/weekdays presets become weekly day sets, which is also what an edit
 * writes back.
 */
function toEditorSchedule(schedule: Schedule): EditorSchedule {
  if (schedule.kind === 'daily') {
    return { kind: 'weekly', days: ALL_DAYS, hour: schedule.hour, minute: schedule.minute }
  }
  if (schedule.kind === 'weekdays') {
    return { kind: 'weekly', days: WEEKDAYS, hour: schedule.hour, minute: schedule.minute }
  }
  if (
    schedule.kind === 'weekly' ||
    schedule.kind === 'once' ||
    schedule.kind === 'interval' ||
    schedule.kind === 'cron'
  ) {
    return schedule
  }
  return { kind: 'weekly', days: WEEKDAYS, hour: 9, minute: 0 }
}

const pad2 = (n: number): string => n.toString().padStart(2, '0')

// A one-shot is stored as an epoch but edited as the wall-clock instant the user
// means, which is exactly what `datetime-local` holds (no zone suffix): reading
// it back with `new Date()` therefore parses as local time.
function toLocalStamp(ms: number): string {
  const when = new Date(ms)
  return (
    `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}` +
    `T${pad2(when.getHours())}:${pad2(when.getMinutes())}`
  )
}

/** Local wall-clock stamp for the cron card's next-run preview. */
function formatLocal(ms: number, zh: boolean): string {
  const when = new Date(ms)
  const date = zh
    ? `${when.getFullYear()}/${pad2(when.getMonth() + 1)}/${pad2(when.getDate())}`
    : `${pad2(when.getMonth() + 1)}/${pad2(when.getDate())}/${when.getFullYear()}`
  return `${date} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`
}

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

  // One card per trigger method; each arms a run of its own. An empty list is a
  // manual task, and legacy daily/weekdays entries display as weekly day sets.
  const schedules = schedulesOf(task).map(toEditorSchedule)
  const isManual = schedules.length === 0

  const setSchedules = (next: EditorSchedule[]): void =>
    setTask((prev) => withSchedules(prev, next))
  const updateSchedule = (index: number, next: EditorSchedule): void =>
    setSchedules(schedules.map((entry, i) => (i === index ? next : entry)))

  const addSchedule = (): void => {
    // An interval is the default second method: it is the cadence a weekly card
    // cannot express, and it never looks like a copy of the first card.
    setSchedules([...schedules, { kind: 'interval', minutes: 60 }])
  }
  const removeSchedule = (index: number): void => {
    const next = schedules.filter((_, i) => i !== index)
    setTask((prev) => ({
      // An empty list is a manual task, which is always stored enabled so the
      // list does not show a disabled switch with nothing left to run.
      ...withSchedules(prev, next),
      enabled: next.length === 0 ? true : prev.enabled,
    }))
  }

  const changeMode = (index: number, kind: EditorSchedule['kind']): void => {
    const current = schedules[index]!
    if (current.kind === kind) return
    if (kind === 'interval') {
      updateSchedule(index, { kind: 'interval', minutes: 60 })
      return
    }
    if (kind === 'once') {
      // Defaults to the next full hour so the method is armable the moment it is
      // switched; the instant the picker holds is what actually fires.
      const when = new Date()
      when.setMinutes(0, 0, 0)
      when.setHours(when.getHours() + 1)
      updateSchedule(index, { kind: 'once', at: when.getTime() })
      return
    }
    const hour = current.kind === 'weekly' ? current.hour : 9
    const minute = current.kind === 'weekly' ? current.minute : 0
    if (kind === 'cron') {
      // Keep the hour the user already picked: switching from weekly to cron
      // usually means "same time, different cadence", and a one-line pattern is
      // the easiest thing to edit.
      updateSchedule(index, { kind: 'cron', expression: `${minute} ${hour} * * *` })
      return
    }
    const days = current.kind === 'weekly' && current.days.length > 0 ? current.days : WEEKDAYS
    updateSchedule(index, { kind: 'weekly', days, hour, minute })
  }

  const setDays = (index: number, days: number[]): void => {
    const current = schedules[index]
    if (current?.kind !== 'weekly') return
    updateSchedule(index, {
      ...current,
      days: Array.from(new Set(days)).sort((a, b) => a - b),
    })
  }
  const toggleDay = (index: number, day: number): void => {
    const current = schedules[index]
    if (current?.kind !== 'weekly') return
    const has = current.days.includes(day)
    // Keep at least one day selected so the schedule is never empty.
    if (has && current.days.length === 1) return
    setDays(index, has ? current.days.filter((d) => d !== day) : [...current.days, day])
  }

  const setTime = (index: number, hour: number, minute: number): void => {
    const current = schedules[index]
    if (current?.kind !== 'weekly') return
    updateSchedule(index, { ...current, hour, minute })
  }
  const onTimeChange = (index: number, value: string): void => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return
    setTime(
      index,
      Math.min(23, Math.max(0, Number(match[1]))),
      Math.min(59, Math.max(0, Number(match[2]))),
    )
  }

  const setOnce = (index: number, value: string): void => {
    const at = new Date(value).getTime()
    if (!Number.isFinite(at)) return
    updateSchedule(index, { kind: 'once', at })
  }
  const setCron = (index: number, expression: string): void => {
    updateSchedule(index, { kind: 'cron', expression })
  }

  // An unparseable cron expression must not be saved: storage keeps it so the
  // card can show the typo, but the scheduler would never arm it.
  const hasInvalidCron = schedules.some(
    (entry) => entry.kind === 'cron' && normalizeCronExpression(entry.expression) === null,
  )
  const canSave =
    task.name.trim().length > 0 &&
    (task.kind !== 'workflow' || !!task.workflowId) &&
    !hasInvalidCron

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
          <p className="hint">{t.taskScheduleHint}</p>

          {isManual && (
            <div className="manual-block">
              <div className="schedule-preview" aria-live="polite">
                {describeSchedule({ kind: 'none' }, zh ? 'zh' : 'en')}
              </div>
              <p className="hint">{t.taskManualHint}</p>
            </div>
          )}

          {schedules.map((sched, index) => {
            const cronValid =
              sched.kind !== 'cron' || normalizeCronExpression(sched.expression) !== null
            const cronNext =
              sched.kind === 'cron' && cronValid ? nextRunAt(sched, Date.now()) : null
            return (
              <div
                className="mb-2 rounded-lg border border-border bg-panel-2 p-3"
                data-schedule-index={index}
                key={index}
              >
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t.taskSchedule}
                    disabled={saving}
                    onChange={(event) =>
                      changeMode(index, event.target.value as EditorSchedule['kind'])
                    }
                    value={sched.kind}
                  >
                    <option value="weekly">{t.taskSchedModeWeekly}</option>
                    <option value="once">{t.taskSchedOnce}</option>
                    <option value="interval">{t.taskSchedModeInterval}</option>
                    <option value="cron">{t.taskSchedModeCron}</option>
                  </select>
                  <button
                    aria-label={t.taskScheduleRemove}
                    className="icon-btn danger ml-auto"
                    disabled={saving}
                    onClick={() => removeSchedule(index)}
                    title={t.taskScheduleRemove}
                    type="button"
                  >
                    <Trash2 aria-hidden size={15} />
                  </button>
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
                            disabled={saving}
                            key={day.value}
                            onClick={() => toggleDay(index, day.value)}
                            type="button"
                          >
                            {zh ? day.zh : day.en}
                          </button>
                        )
                      })}
                    </div>
                    <div className="day-quick">
                      <button
                        disabled={saving}
                        onClick={() => setDays(index, WEEKDAYS)}
                        type="button"
                      >
                        {t.taskDaysWeekdays}
                      </button>
                      <button
                        disabled={saving}
                        onClick={() => setDays(index, WEEKEND)}
                        type="button"
                      >
                        {t.taskDaysWeekend}
                      </button>
                      <button
                        disabled={saving}
                        onClick={() => setDays(index, ALL_DAYS)}
                        type="button"
                      >
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
                        onChange={(event) => setOnce(index, event.target.value)}
                        type="datetime-local"
                        value={toLocalStamp(sched.at)}
                      />
                    </label>
                    <p className="hint">{t.taskOnceHint}</p>
                  </div>
                )}

                {sched.kind === 'weekly' && (
                  <div className="schedule-config">
                    <label className="time-input">
                      <input
                        disabled={saving}
                        onChange={(event) => onTimeChange(index, event.target.value)}
                        type="time"
                        value={`${pad2(sched.hour)}:${pad2(sched.minute)}`}
                      />
                    </label>
                  </div>
                )}

                {sched.kind === 'interval' && (
                  <div className="schedule-config">
                    <label className="interval-input">
                      <NumberInput
                        disabled={saving}
                        min={1}
                        value={sched.minutes}
                        onChange={(n) => updateSchedule(index, { kind: 'interval', minutes: n })}
                      />
                      <span>{t.taskMinutes}</span>
                    </label>
                  </div>
                )}

                {sched.kind === 'cron' && (
                  <div className="schedule-config">
                    <input
                      aria-label={t.taskCronExpression}
                      className="w-full rounded-lg border border-border bg-panel px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
                      disabled={saving}
                      onChange={(event) => setCron(index, event.target.value)}
                      spellCheck={false}
                      value={sched.expression}
                    />
                    <p className="hint">{t.taskCronHint}</p>
                    {!cronValid && <p className="hint banner-error-inline">{t.taskCronInvalid}</p>}
                    {cronValid && cronNext !== null && (
                      <p aria-live="polite" className="schedule-preview">
                        {t.taskCronNext({ when: formatLocal(cronNext, zh) })}
                      </p>
                    )}
                    {cronValid && cronNext === null && (
                      <p className="hint banner-error-inline">{t.taskCronNoNext}</p>
                    )}
                  </div>
                )}

                {sched.kind !== 'cron' && (
                  <div className="schedule-preview" aria-live="polite">
                    {describeSchedule(sched, zh ? 'zh' : 'en', Date.now())}
                  </div>
                )}
              </div>
            )
          })}

          <button className="w-full" disabled={saving} onClick={addSchedule} type="button">
            + {t.taskScheduleAdd}
          </button>
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
