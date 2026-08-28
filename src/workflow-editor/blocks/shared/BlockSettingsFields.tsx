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
 * Automa also exposes connection-line settings and an insert-data table here;
 * our engine does not implement either, so those rows are intentionally
 * omitted rather than shown as non-functional UI.
 *
 * @module workflow-editor/blocks/shared/BlockSettingsFields
 */

import type { EditFormProps } from '../EditForms'
import { Select, Switch, TextInput } from './Field'
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
    </div>
  )
}

/** On-error tab (Automa BlockSettingOnError). */
export function OnErrorFields({ data, onChange }: EditFormProps) {
  const { t } = useEditorLocale()
  const onError = onErrorOf(data)
  const setOnError = (patch: Partial<OnError>) => onChange({ onError: { ...onError, ...patch } })
  const toDo = str(onError as unknown as Record<string, unknown>, 'toDo') || 'error'

  return (
    <div className="wf-onerror">
      {/* Automa's green info banner (bg-green-200 / dark:bg-green-300). */}
      <div className="wf-onerror-banner">
        <i className="ri-information-line" />
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
              <div className="wf-inline-field" title="The number of times to retry the action">
                <span>{t('times')}</span>
                <i className="ri-information-line" />
                <div className="wf-inline-input">
                  <TextInput
                    type="number"
                    value={num(onError as unknown as Record<string, unknown>, 'retryTimes', 1)}
                    onChange={(v) => setOnError({ retryTimes: Math.max(0, Number(v) || 0) })}
                  />
                </div>
              </div>
              {/* Automa: indented "Interval ⓘ [input] seconds" row. */}
              <div className="wf-inline-field wf-inline-field-indent" title="Seconds to wait between each try">
                <span>{t('interval')}</span>
                <i className="ri-information-line" />
                <div className="wf-inline-input">
                  <TextInput
                    type="number"
                    value={num(onError as unknown as Record<string, unknown>, 'retryInterval', 2)}
                    onChange={(v) => setOnError({ retryInterval: Math.max(0, Number(v) || 0) })}
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
