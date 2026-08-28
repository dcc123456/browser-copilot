/**
 * EditExecuteWorkflow — React port of Automa's EditExecuteWorkflow.vue.
 *
 * Automa populates the workflow dropdown from the local workflow store (plus
 * team workflows). This build has no such store in the editor, so the
 * workflow to run is a plain text input for the workflow id, per porting
 * scope (TODO: replace with a workflow picker once the store is available).
 * Global data is a mono JSON textarea instead of the CodeMirror modal.
 *
 * Fields: workflowId, executeId, globalData, insertAllGlobalData,
 * insertAllVars (+ insertVars comma list).
 *
 * @module workflow-editor/blocks/batchC/EditExecuteWorkflow
 */

import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditExecuteWorkflow({ data, onChange }: EditFormProps) {
  const insertAllVars = bool(data, 'insertAllVars')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      {/* TODO: Automa renders a <select> of local/team workflows here; this
          build has no workflow store in the editor, so take the id directly. */}
      <Field label="Workflow to execute (workflow id)">
        <TextInput
          value={str(data, 'workflowId')}
          placeholder="Select workflow — paste the workflow id"
          onChange={(v) => onChange({ workflowId: v })}
        />
      </Field>

      <Field label="Execute Id (optional)" title="Execute Id (optional)">
        <TextInput value={str(data, 'executeId')} placeholder="abc123" onChange={(v) => onChange({ executeId: v })} />
      </Field>

      <p className="wf-form-note" style={{ marginTop: 12 }}>
        Global data
      </p>
      <Checkbox
        checked={bool(data, 'insertAllGlobalData')}
        onChange={(v) => onChange({ insertAllGlobalData: v })}
        label="Use all current workflow globalData"
      />

      <Field label="Global data (JSON)">
        <TextArea
          mono
          rows={6}
          value={str(data, 'globalData')}
          placeholder={'{\n  "key": "value"\n}'}
          onChange={(v) => onChange({ globalData: v })}
        />
      </Field>
      <p className="wf-form-note">This will overwrite the global data of the selected workflow.</p>

      <Checkbox checked={insertAllVars} onChange={(v) => onChange({ insertAllVars: v })} label="Use all current workflow variables" />

      {!insertAllVars && (
        <>
          <Field label="Insert current workflow variables">
            <TextArea
              value={str(data, 'insertVars')}
              placeholder="varA,varB,varC"
              onChange={(v) => onChange({ insertVars: v })}
            />
          </Field>
          <p className="wf-form-note">Use commas to separate the variable names.</p>
        </>
      )}
    </div>
  )
}
