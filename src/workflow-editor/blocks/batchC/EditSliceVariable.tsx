/**
 * EditSliceVariable — React port of Automa's EditSliceVariable.vue.
 *
 * Extracts a section of a variable value: optional start index and/or end
 * index (each behind a checkbox). Fields: variableName, startIdxEnabled,
 * startIndex, endIdxEnabled, endIndex.
 *
 * @module workflow-editor/blocks/batchC/EditSliceVariable
 */

import { Checkbox, Field, NumberInput, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditSliceVariable({ data, onChange }: EditFormProps) {
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

      <Checkbox
        checked={bool(data, 'startIdxEnabled')}
        onChange={(v) => onChange({ startIdxEnabled: v })}
        label="Start index"
      />
      {bool(data, 'startIdxEnabled') && (
        <Field label="Start index">
          <NumberInput value={num(data, 'startIndex', 0)} placeholder="0" fallback={0} onChange={(n) => onChange({ startIndex: n })} />
        </Field>
      )}

      <Checkbox checked={bool(data, 'endIdxEnabled')} onChange={(v) => onChange({ endIdxEnabled: v })} label="End index" />
      {bool(data, 'endIdxEnabled') && (
        <Field label="End index">
          <NumberInput value={num(data, 'endIndex', 0)} placeholder="0" fallback={0} onChange={(n) => onChange({ endIndex: n })} />
        </Field>
      )}
    </div>
  )
}
