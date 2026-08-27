/**
 * EditWaitConnections — React port of Automa's EditWaitConnections.vue
 * (block: wait-connections).
 *
 * Timeout and an optional "only continue a specific flow" toggle; Automa
 * fills the flow selector from the workflow's connection blocks, which the
 * editor does not have access to, so the flow block id is edited as text.
 *
 * @module workflow-editor/blocks/batchB/EditWaitConnections
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

export default function EditWaitConnections({ data, onChange }: EditFormProps) {
  const specificFlow = bool(data, 'specificFlow')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Timeout (milliseconds)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 10000)}
          placeholder="10000"
          onChange={(v) => onChange({ timeout: Number(v) || 0 })}
        />
      </Field>

      <Checkbox
        checked={specificFlow}
        onChange={(v) => onChange({ specificFlow: v })}
        label="Only continue a specific flow"
      />

      {specificFlow && (
        <Field label="Select flow (block id)">
          <TextInput
            value={str(data, 'flowBlockId')}
            placeholder="Block id of the flow"
            onChange={(v) => onChange({ flowBlockId: v })}
          />
        </Field>
      )}
    </div>
  )
}
