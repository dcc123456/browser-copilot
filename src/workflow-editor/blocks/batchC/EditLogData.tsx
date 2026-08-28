/**
 * EditLogData — React port of Automa's EditLogData.vue.
 *
 * Fetches the latest log data of a (workflow) and stores it in a table
 * column or a variable. The workflow picker is a plain id input here (no
 * workflow store in the editor); the output strip offers the variable
 * assignment. Table columns are not enumerated in this build, so the data
 * column is a text field instead of the <insert-workflow-data> select.
 *
 * @module workflow-editor/blocks/batchC/EditLogData
 */

import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { AssignVariable } from './shared'

export default function EditLogData({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      {/* TODO: Automa renders a <select> of workflows here; take the id. */}
      <Field label="Workflow (workflow id)" title="Select workflow">
        <TextInput
          value={str(data, 'workflowId')}
          placeholder="Select workflow — paste the workflow id"
          onChange={(v) => onChange({ workflowId: v })}
        />
      </Field>

      {str(data, 'workflowId') && (
        <>
          <p className="wf-form-note" style={{ marginTop: 12 }}>
            Log data
          </p>
          <AssignVariable data={data} onChange={onChange} />
          <Field label="Insert to table (column name)">
            <TextInput
              value={typeof data.dataColumn === 'string' ? data.dataColumn : ''}
              placeholder="Select column"
              onChange={(v) => onChange({ dataColumn: v, saveData: true })}
            />
          </Field>
        </>
      )}
    </div>
  )
}
