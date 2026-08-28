/**
 * SaveOutputs — React port of Automa's InsertWorkflowData (variables table).
 *
 * Renders the "Assign to variable" checkbox (with a variable-name input) that
 * Automa appends to every block producing output data (`<insert-workflow-data
 * variables />`). Automa additionally offers an "Insert to table" column
 * picker fed by the live workflow table; here the table/columns context is not
 * wired into the editor, so only the variables section is ported — the
 * `saveData` / `dataColumn` keys are left in the block data untouched.
 *
 * @module workflow-editor/blocks/batchB/SaveOutputs
 */

import type { Patch } from '../shared/Field'
import { Checkbox, Field, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

export interface SaveOutputsProps {
  data: Record<string, unknown>
  onChange: Patch
}

export default function SaveOutputs({ data, onChange }: SaveOutputsProps) {
  return (
    <>
      <Checkbox
        checked={bool(data, 'assignVariable')}
        onChange={(v) => onChange({ assignVariable: v })}
        label="Assign to variable"
      />
      {bool(data, 'assignVariable') && (
        <Field label="Variable name">
          <TextInput
            value={str(data, 'variableName')}
            placeholder="Variable name"
            onChange={(v) => onChange({ variableName: v })}
          />
        </Field>
      )}
    </>
  )
}
