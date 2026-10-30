/**
 * EditLogData — React port of Automa's EditLogData.vue.
 *
 * Fetches the latest log data of a workflow and stores it in a table column or
 * a variable. The workflow is picked from the saved-workflow dropdown (the
 * shared {@link WorkflowPicker}, same source as execute-workflow); table
 * columns are not enumerated in this build, so the data column is a text field
 * instead of Automa's <insert-workflow-data> select.
 *
 * @module workflow-editor/blocks/batchC/EditLogData
 */

import { useEditorLocale } from '../../locale-context'
import { Field, TextArea, TextInput } from '../shared/Field'
import WorkflowPicker from '../shared/WorkflowPicker'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { AssignVariable } from './shared'

export default function EditLogData({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const workflowId = str(data, 'workflowId')
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <WorkflowPicker
        label="Workflow"
        value={workflowId}
        onChange={(v) => onChange({ workflowId: v })}
      />

      {workflowId && (
        <>
          <p className="wf-form-note mt-3">{bt('Log data')}</p>
          <AssignVariable data={data} onChange={onChange} />
          <Field label="Insert to table (column name)">
            <TextInput
              value={typeof data.dataColumn === 'string' ? data.dataColumn : ''}
              placeholder="Select column"
              onChange={(v) => onChange({ dataColumn: v, saveData: true })}
              noSlash
            />
          </Field>
        </>
      )}
    </div>
  )
}
