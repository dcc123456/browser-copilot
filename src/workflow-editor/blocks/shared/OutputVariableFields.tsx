/**
 * OutputVariableFields — the shared "assign to variable" strip appended to
 * every block that produces output data (Automa's <insert-workflow-data
 * variables /> slot): the checkbox plus, when enabled, the variable-name
 * input. Binds the `assignVariable` / `variableName` data keys.
 *
 * Previously duplicated as batchA's AssignVariableFields, batchC's
 * AssignVariable and batchB's SaveOutputs — those are thin wrappers now.
 *
 * @module workflow-editor/blocks/shared/OutputVariableFields
 */

import { Checkbox, Field, TextInput, type Patch } from './Field'
import { bool, str } from './InteractionBase'

export default function OutputVariableFields({
  data,
  onChange,
  checkboxLabel = 'Assign to variable',
  placeholder = 'Variable name',
}: {
  data: Record<string, unknown>
  onChange: Patch
  /** Checkbox label; sites keep their original English string for i18n. */
  checkboxLabel?: string
  placeholder?: string
}) {
  const assignVariable = bool(data, 'assignVariable')
  return (
    <>
      <Checkbox
        checked={assignVariable}
        onChange={(v) => onChange({ assignVariable: v })}
        label={checkboxLabel}
      />
      {assignVariable && (
        <Field label="Variable name">
          <TextInput
            value={str(data, 'variableName')}
            placeholder={placeholder}
            onChange={(v) => onChange({ variableName: v })}
          />
        </Field>
      )}
    </>
  )
}
