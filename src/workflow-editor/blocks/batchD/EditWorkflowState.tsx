/**
 * EditWorkflowState — React port of Automa's EditWorkflowState.vue.
 *
 * Manages running workflow state: stop all / stop current / stop specific
 * workflows. Automa's "stop specific" picks workflows from the workflow store
 * via an autocomplete; the standalone editor has no such store, so workflow ids
 * are entered directly (comma separated). `exceptCurrent` applies to stop-all
 * and `throwError` + message apply to stop-current.
 *
 * @module workflow-editor/blocks/batchD/EditWorkflowState
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export default function EditWorkflowState({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'stop-current'

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Action">
        <Select
          value={type}
          onChange={(v) => onChange({ type: v })}
          options={[
            { value: 'stop-all', label: 'Stop all workflows' },
            { value: 'stop-current', label: 'Stop current workflow' },
            { value: 'stop-specific', label: 'Stop specific workflows' },
          ]}
        />
      </Field>

      {type === 'stop-all' && (
        <Checkbox
          checked={bool(data, 'exceptCurrent')}
          onChange={(v) => onChange({ exceptCurrent: v })}
          label="Except for the current workflow"
        />
      )}

      {type === 'stop-current' && (
        <>
          <Checkbox checked={bool(data, 'throwError')} onChange={(v) => onChange({ throwError: v })} label="Throw error" />
          {bool(data, 'throwError') && (
            <Field label="Error message">
              <TextInput
                value={str(data, 'errorMessage')}
                placeholder="Error message"
                onChange={(v) => onChange({ errorMessage: v })}
              />
            </Field>
          )}
        </>
      )}

      {type === 'stop-specific' && (
        <Field label="Workflow IDs (comma separated)">
          <TextInput
            value={asStringList(data.workflowsToStop).join(', ')}
            placeholder="workflow-id-1, workflow-id-2"
            onChange={(v) =>
              onChange({
                workflowsToStop: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      )}
    </div>
  )
}
