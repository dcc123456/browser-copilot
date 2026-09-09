/**
 * Shared helpers for batch C (DATA + CONTROL-FLOW) block edit forms.
 *
 * - `id()` — a cheap local nanoid stand-in (no new deps); only needs to be
 *   unique within a single condition/map session.
 * - `AssignVariable` — React port of Automa's <insert-workflow-data variables>
 *   strip: an "assign the result to a variable" checkbox plus a variable name
 *   input, bound to the `assignVariable` / `variableName` data fields.
 *
 * @module workflow-editor/blocks/batchC/shared
 */

import type { ReactNode } from 'react'
import type { EditFormProps } from '../EditForms'
import OutputVariableFields from '../shared/OutputVariableFields'
import { Checkbox, Field, TextInput } from '../shared/Field'

let counter = 0
/** Small unique id (Automa used nanoid(4..10)). */
export function id(size = 8): string {
  counter += 1
  const rand = Math.random()
    .toString(36)
    .slice(2, 2 + size)
  return `${Date.now().toString(36).slice(-4)}${rand}${counter.toString(36)}`.slice(0, size + 4)
}

/** Coerce an unknown value to an array (defaulting to []). */
export function arr<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * "Assign to a variable" output row (Automa's InsertWorkflowData `variables`
 * slot) — shared OutputVariableFields with batchC's original label strings.
 */
export function AssignVariable(props: Pick<EditFormProps, 'data' | 'onChange'>) {
  return <OutputVariableFields {...props} checkboxLabel="Assign to a variable" placeholder="abc123" />
}

/** "Insert to table" dataColumn row kept simple (no live column list yet). */
export function SaveToTable({ data, onChange }: Pick<EditFormProps, 'data' | 'onChange'>) {
  const saveData = data.saveData === true
  return (
    <>
      <Checkbox
        checked={saveData}
        onChange={(v) => onChange({ saveData: v })}
        label="Insert to table"
      />
      {saveData && (
        <Field label="Select column">
          <TextInput
            value={typeof data.dataColumn === 'string' ? data.dataColumn : ''}
            placeholder="Column id / name"
            onChange={(v) => onChange({ dataColumn: v })}
          />
        </Field>
      )}
    </>
  )
}

/** Simple labeled note paragraph. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="wf-form-note">{children}</p>
}
