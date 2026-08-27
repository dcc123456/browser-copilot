/**
 * Block settings — React port of Automa's BlockSettingsModal section:
 * disable the block, and the on-error policy (retry N times / fallback edge).
 * Rendered at the bottom of every block edit form.
 *
 * @module workflow-editor/blocks/shared/BlockSettings
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, Select, TextInput } from './Field'
import { bool, num, str } from './InteractionBase'

interface OnError {
  enable?: boolean
  toDo?: 'retry' | 'fallback' | 'error'
  retryTimes?: number
  retryInterval?: number
}

export default function BlockSettings({ data, onChange }: EditFormProps) {
  const onError = (data['onError'] as OnError | undefined) ?? {}
  const setOnError = (patch: Partial<OnError>) =>
    onChange({ onError: { ...onError, ...patch } })

  return (
    <div className="wf-block-settings">
      <Expand title="Settings">
        <Checkbox
          checked={bool(data, 'disableBlock')}
          onChange={(v) => onChange({ disableBlock: v })}
          label="Disable this block"
          title="Skip the block when the workflow runs"
        />
      </Expand>

      <Expand title="On error">
        <Checkbox
          checked={onError.enable === true}
          onChange={(v) => setOnError({ enable: v })}
          label="Handle block errors"
        />
        {onError.enable && (
          <>
            <Field label="On error, do">
              <Select
                value={str(onError as unknown as Record<string, unknown>, 'toDo') || 'error'}
                onChange={(v) => setOnError({ toDo: v as OnError['toDo'] })}
                options={[
                  { value: 'error', label: 'Stop the workflow with an error' },
                  { value: 'retry', label: 'Retry the block' },
                  { value: 'fallback', label: 'Continue via the fallback connection' },
                ]}
              />
            </Field>
            {onError.toDo === 'retry' && (
              <>
                <Field label="Retry times">
                  <TextInput
                    type="number"
                    value={num(onError as unknown as Record<string, unknown>, 'retryTimes', 1)}
                    onChange={(v) => setOnError({ retryTimes: Math.max(0, Number(v) || 0) })}
                  />
                </Field>
                <Field label="Retry interval (ms)">
                  <TextInput
                    type="number"
                    value={num(onError as unknown as Record<string, unknown>, 'retryInterval', 1000)}
                    onChange={(v) =>
                      setOnError({ retryInterval: Math.max(0, Number(v) || 0) })
                    }
                  />
                </Field>
              </>
            )}
            {onError.toDo === 'fallback' && (
              <p className="wf-form-note">
                Connect a block to the extra “fallback” handle on this node.
              </p>
            )}
          </>
        )}
      </Expand>
    </div>
  )
}
