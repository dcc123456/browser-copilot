/**
 * Shared internals for the batch-A block edit forms.
 *
 * - `AssignVariableFields` / `TableFields` / `ExtraRowFields` are the React
 *   port of Automa's `InsertWorkflowData.vue` (the "Assign to variable" /
 *   "Insert to table" / "Add extra row" group used at the bottom of the
 *   get-value forms). Automa's table-column dropdown is fed by the live
 *   workflow's columns, which the React editor does not expose yet, so the
 *   column selectors are rendered as plain text inputs.
 * - `nanoid` is a tiny id generator used for the loop block's `loopId`,
 *   matching Automa's `nanoid(6)` (non-secure alphabet).
 *
 * @module workflow-editor/blocks/batchA/_shared
 */
import { Checkbox, Field, TextInput } from '../shared/Field'
import type { Patch } from '../shared/Field'

/** `nanoid(6)` equivalent using the same default alphabet as Automa. */
export function nanoid(size = 6): string {
  const alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjczqvwitr'
  let id = ''
  for (let i = 0; i < size; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return id
}

export function AssignVariableFields({ data, onChange }: { data: Record<string, unknown>; onChange: Patch }) {
  const assignVariable = data.assignVariable === true
  return (
    <>
      <Checkbox
        checked={assignVariable}
        onChange={(v) => onChange({ assignVariable: v })}
        label="Assign to variable"
      />
      {assignVariable && (
        <Field label="Variable name">
          <TextInput
            value={typeof data.variableName === 'string' ? data.variableName : ''}
            placeholder="Variable name"
            onChange={(v) => onChange({ variableName: v })}
          />
        </Field>
      )}
    </>
  )
}

/**
 * "Insert to table" checkbox + column picker. Automa fills the column
 * dropdown from the current workflow's columns; here the column name is a
 * free-text input.
 */
export function TableFields({ data, onChange }: { data: Record<string, unknown>; onChange: Patch }) {
  const saveData = data.saveData === true
  return (
    <>
      <Checkbox checked={saveData} onChange={(v) => onChange({ saveData: v })} label="Insert to table" />
      {saveData && (
        <Field label="Select column">
          <TextInput
            value={typeof data.dataColumn === 'string' ? data.dataColumn : ''}
            placeholder="Select column"
            onChange={(v) => onChange({ dataColumn: v })}
          />
        </Field>
      )}
    </>
  )
}

/** "Add extra row" checkbox + value/column inputs (port of InsertWorkflowData's extraRow slot). */
export function ExtraRowFields({ data, onChange }: { data: Record<string, unknown>; onChange: Patch }) {
  const addExtraRow = data.addExtraRow === true
  return (
    <>
      <Checkbox
        checked={addExtraRow}
        onChange={(v) => onChange({ addExtraRow: v })}
        label="Add extra row"
      />
      {addExtraRow && (
        <>
          <Field label="Value of the extra row">
            <TextInput
              value={typeof data.extraRowValue === 'string' ? data.extraRowValue : ''}
              placeholder="Value"
              onChange={(v) => onChange({ extraRowValue: v })}
            />
          </Field>
          <Field label="Extra row column">
            <TextInput
              value={typeof data.extraRowDataColumn === 'string' ? data.extraRowDataColumn : ''}
              placeholder="Select column"
              onChange={(v) => onChange({ extraRowDataColumn: v })}
            />
          </Field>
        </>
      )}
    </>
  )
}

/** Wrapper with the Automa slot layout: checkbox block + inputs. */
export function InsertDataFields({
  data,
  onChange,
  variables,
  table,
  extraRow,
}: {
  data: Record<string, unknown>
  onChange: Patch
  variables?: boolean
  table?: boolean
  extraRow?: boolean
}) {
  return (
    <>
      {variables && <AssignVariableFields data={data} onChange={onChange} />}
      {table && <TableFields data={data} onChange={onChange} />}
      {extraRow && <ExtraRowFields data={data} onChange={onChange} />}
    </>
  )
}


