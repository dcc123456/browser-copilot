/**
 * EditExecuteWorkflow — React port of Automa's EditExecuteWorkflow.vue.
 *
 * Automa populates the workflow dropdown from its local workflow store; this
 * build does the same through the `workflows.list` command (the store lives in
 * the service worker). The list loads when the form opens and can be refreshed
 * with the button next to the select, so workflows saved after the editor
 * opened still show up.
 *
 * Edge cases handled deliberately:
 * - The workflow being edited is excluded from the list (self-execution is a
 *   guaranteed loop the engine would only reject at run time). When the meta
 *   context is absent (block-settings modal), nothing is excluded.
 * - A stored `workflowId` that no longer resolves (deleted workflow, or a value
 *   saved by an older build) still renders as an option, so opening and saving
 *   the form never silently rewrites it.
 * - With no saved workflows at all, the select stays but a hint points at the
 *   Workflows tab instead of leaving an empty dropdown to guess at.
 *
 * Global data is a mono JSON textarea inside a modal, matching Automa's
 * dedicated global-data popup.
 *
 * Fields: workflowId, executeId, globalData, insertAllGlobalData,
 * insertAllVars (+ insertVars comma list).
 *
 * @module workflow-editor/blocks/batchC/EditExecuteWorkflow
 */

import { useEditorLocale } from '../../locale-context'
import { useWorkflowMeta } from '../batchD/WorkflowInfoFields'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import PopupField from '../shared/PopupField'
import WorkflowPicker from '../shared/WorkflowPicker'
import { bool, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditExecuteWorkflow({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const insertAllVars = bool(data, 'insertAllVars')
  const selfId = useWorkflowMeta()?.meta.id ?? null
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
        label="Workflow to execute"
        value={workflowId}
        onChange={(v) => onChange({ workflowId: v })}
        excludeId={selfId}
      />

      <Field label="Execute Id (optional)" title="Execute Id (optional)">
        <TextInput
          value={str(data, 'executeId')}
          placeholder="abc123"
          onChange={(v) => onChange({ executeId: v })}
        />
      </Field>

      <p className="wf-form-note mt-3">{bt('Global data')}</p>
      <Checkbox
        checked={bool(data, 'insertAllGlobalData')}
        onChange={(v) => onChange({ insertAllGlobalData: v })}
        label="Use all current workflow globalData"
      />

      <PopupField
        title="Global data (JSON)"
        summary={
          str(data, 'globalData').trim()
            ? `${str(data, 'globalData').length} ${bt('chars')}`
            : bt('None')
        }
        editLabel="Edit global data"
        icon="lucide:Brackets"
        size="md"
      >
        <Field label="Global data (JSON)">
          <TextArea
            mono
            rows={12}
            value={str(data, 'globalData')}
            placeholder={'{\n  "key": "value"\n}'}
            onChange={(v) => onChange({ globalData: v })}
          />
        </Field>
        <p className="wf-form-note">
          {bt('This will overwrite the global data of the selected workflow.')}
        </p>
      </PopupField>

      <Checkbox
        checked={insertAllVars}
        onChange={(v) => onChange({ insertAllVars: v })}
        label="Use all current workflow variables"
      />

      {!insertAllVars && (
        <>
          <Field label="Insert current workflow variables">
            <TextArea
              value={str(data, 'insertVars')}
              placeholder="varA,varB,varC"
              onChange={(v) => onChange({ insertVars: v })}
            />
          </Field>
          <p className="wf-form-note">{bt('Use commas to separate the variable names.')}</p>
        </>
      )}
    </div>
  )
}
