/**
 * EditIncreaseVariable — React port of Automa's EditIncreaseVariable.vue.
 *
 * Increases a numeric variable by a fixed amount. Fields: variableName,
 * increaseBy (number).
 *
 * @module workflow-editor/blocks/batchC/EditIncreaseVariable
 */

import { Field, TextArea, TextInput } from '../shared/Field'
import { num, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditIncreaseVariable({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Variable name" title="Variable name">
        <TextInput value={str(data, 'variableName')} placeholder="abc123" onChange={(v) => onChange({ variableName: v })} />
      </Field>

      <Field label="Increase by">
        <TextInput
          type="number"
          value={num(data, 'increaseBy', 1)}
          placeholder="0"
          onChange={(v) => onChange({ increaseBy: Number(v) || 0 })}
        />
      </Field>
    </div>
  )
}
