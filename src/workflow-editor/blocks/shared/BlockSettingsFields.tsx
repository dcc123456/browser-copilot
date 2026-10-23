/**
 * Block settings + on-error fields — React port of Automa's
 * BlockSettingGeneral + BlockSettingOnError, hosted as TABS inside the
 * block-settings modal (Automa EditBlockSettings.vue: General / On error).
 *
 *  - <GeneralFields>:  row list — description text left, control right.
 *  - <OnErrorFields>:  green info bar → Enable switch → Retry switch
 *                      (inline Times / Interval + "seconds") → behaviour
 *                      select → custom error message for "throw".
 *
 * Automa's connection-line settings live in a separate Lines tab
 * (`BlockSettingsModal`); the insert-data table stays inside the block's own
 * form, so it is intentionally not duplicated here.
 *
 * @module workflow-editor/blocks/shared/BlockSettingsFields
 */

import { Info } from 'lucide-react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, NumberInput, Select, Switch, TextInput } from './Field'
import { bool, num, str } from './InteractionBase'
import { useEditorLocale } from '../../locale-context'

export interface OnError {
  enable?: boolean
  retry?: boolean
  toDo?: 'error' | 'continue' | 'fallback'
  retryTimes?: number
  /** Interval between retries, in seconds (Automa uses seconds). */
  retryInterval?: number
  /** Custom message thrown when toDo === 'error'. */
  errorMessage?: string
}

/** Read the onError bag off block data, defaulting to an empty object. */
export function onErrorOf(data: Record<string, unknown>): OnError {
  return ((data['onError'] as OnError | undefined) ?? {}) as OnError
}

/**
 * General tab (Automa BlockSettingGeneral): each setting is a row with the
 * title + one-line description on the left and the control on the right.
 */
export function GeneralFields({ data, onChange }: EditFormProps) {
  const { t } = useEditorLocale()
  return (
    <div className="wf-general-list">
      <div className="wf-general-row">
        <div className="wf-general-text">
          <p>{t('disableBlock')}</p>
          <p className="wf-general-desc">{t('disableBlockDesc')}</p>
        </div>
        <Switch
          checked={bool(data, 'disableBlock')}
          onChange={(v) => onChange({ disableBlock: v })}
        />
      </div>
      <div className="wf-general-row">
        <div className="wf-general-text">
          <p>{t('settingsBlockTimeout')}</p>
          <p className="wf-general-desc">{t('settingsBlockTimeoutHint')}</p>
        </div>
        <div className="wf-inline-input">
          <NumberInput
            value={num(data, 'blockTimeout', 0)}
            min={0}
            fallback={0}
            onChange={(n) => onChange({ blockTimeout: n })}
          />
        </div>
      </div>
    </div>
  )
}

/** One outgoing connection and its editable styling. */
export interface LineSetting {
  id: string
  targetLabel: string
  label: string
  animated: boolean
  color: string
}

/** Lines tab (Automa BlockSettingLines): per-connection label / animation / color. */
export function LinesFields({
  lines,
  onChange,
}: {
  lines: LineSetting[]
  onChange: (edgeId: string, patch: { label?: string; animated?: boolean; color?: string }) => void
}) {
  const { t, bt } = useEditorLocale()
  if (lines.length === 0) return <p className="wf-form-note">{t('linesEmpty')}</p>
  return (
    <div className="flex flex-col gap-3">
      {lines.map((line) => (
        <div key={line.id} className="rounded-lg border border-border p-2.5">
          <p className="mb-2 text-xs font-semibold text-ink">{line.targetLabel}</p>
          <Field label={t('linesLineLabel')}>
            <TextInput
              value={line.label}
              placeholder="Label"
              onChange={(value) => onChange(line.id, { label: value })}
              noSlash
            />
          </Field>
          <Checkbox
            checked={line.animated}
            onChange={(value) => onChange(line.id, { animated: value })}
            label={t('linesAnimated')}
          />
          <Field label={t('linesColor')}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={line.color || '#64748b'}
                aria-label={t('linesColor')}
                onChange={(event) => onChange(line.id, { color: event.target.value })}
                className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
              <button
                type="button"
                className="rounded-md border border-border bg-panel px-2 py-1 text-xs text-ink hover:bg-hover"
                onClick={() => onChange(line.id, { color: '' })}
              >
                {bt('Clear')}
              </button>
            </div>
          </Field>
        </div>
      ))}
    </div>
  )
}

/** On-error tab (Automa BlockSettingOnError). */
export function OnErrorFields({ data, onChange }: EditFormProps) {
  const { t, bt } = useEditorLocale()
  const onError = onErrorOf(data)
  const setOnError = (patch: Partial<OnError>) => onChange({ onError: { ...onError, ...patch } })
  const toDo = str(onError as unknown as Record<string, unknown>, 'toDo') || 'error'

  return (
    <div className="wf-onerror">
      {/* Automa's green info banner (bg-green-200 / dark:bg-green-300). */}
      <div className="wf-onerror-banner">
        <Info size={14} />
        <p>{t('theseErrorRules')}</p>
      </div>

      <Switch
        checked={onError.enable === true}
        onChange={(v) => setOnError({ enable: v })}
        label={t('enable')}
      />

      {onError.enable && (
        <>
          <div className="wf-onerror-retry-switch">
            <Switch
              checked={onError.retry === true}
              onChange={(v) => setOnError({ retry: v })}
              label={t('retryAction')}
            />
          </div>

          {onError.retry && (
            <div className="wf-onerror-retry">
              {/* Automa: inline "Times ⓘ [input]" row. */}
              <div
                className="wf-inline-field"
                title={bt('The number of times to retry the action')}
              >
                <span>{t('times')}</span>
                <Info size={14} />
                <div className="wf-inline-input">
                  <NumberInput
                    value={num(onError as unknown as Record<string, unknown>, 'retryTimes', 1)}
                    min={0}
                    fallback={1}
                    onChange={(n) => setOnError({ retryTimes: n })}
                  />
                </div>
              </div>
              {/* Automa: indented "Interval ⓘ [input] seconds" row. */}
              <div
                className="wf-inline-field wf-inline-field-indent"
                title={bt('Seconds to wait between each try')}
              >
                <span>{t('interval')}</span>
                <Info size={14} />
                <div className="wf-inline-input">
                  <NumberInput
                    value={num(onError as unknown as Record<string, unknown>, 'retryInterval', 2)}
                    min={0}
                    fallback={2}
                    onChange={(n) => setOnError({ retryInterval: n })}
                  />
                </div>
                <span className="wf-inline-unit">{t('seconds')}</span>
              </div>
            </div>
          )}

          {/* Behaviour select (w-56, no label — Automa drops it bare). */}
          <div className="wf-onerror-todo">
            <Select
              value={toDo}
              onChange={(v) => setOnError({ toDo: v as OnError['toDo'] })}
              options={[
                { value: 'error', label: t('throwError') },
                { value: 'continue', label: t('continueWorkflow') },
                { value: 'fallback', label: t('fallbackBranch') },
              ]}
            />
          </div>

          {/* Custom error message (placeholder-only input, Automa style). */}
          {toDo === 'error' && (
            <div className="wf-onerror-errmsg">
              <TextInput
                value={str(onError as unknown as Record<string, unknown>, 'errorMessage')}
                placeholder={t('defaultErrorMessage')}
                onChange={(v) => setOnError({ errorMessage: v })}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
