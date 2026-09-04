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
 * Global data is a mono JSON textarea instead of the CodeMirror modal.
 *
 * Fields: workflowId, executeId, globalData, insertAllGlobalData,
 * insertAllVars (+ insertVars comma list).
 *
 * @module workflow-editor/blocks/batchC/EditExecuteWorkflow
 */

import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../../../lib/messages'
import type { Workflow } from '../../../lib/workflow/types'
import { useWorkflowMeta } from '../batchD/WorkflowInfoFields'
import { Checkbox, Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditExecuteWorkflow({ data, onChange }: EditFormProps) {
  const insertAllVars = bool(data, 'insertAllVars')
  const selfId = useWorkflowMeta()?.meta.id ?? null

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback((): void => {
    void sendCommand({ type: 'workflows.list' })
      .then((result) => {
        if (result.type === 'workflows.list') setWorkflows(result.workflows)
      })
      .catch(() => {
        // The worker is briefly unreachable right after a browser restart;
        // the retry button covers it, so keep the form usable.
      })
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const workflowId = str(data, 'workflowId')
  const options = workflows
    .filter((workflow) => workflow.id !== selfId)
    .map((workflow) => ({ value: workflow.id, label: workflow.name }))
  if (workflowId && !options.some((option) => option.value === workflowId)) {
    options.unshift({ value: workflowId, label: `${workflowId}` })
  }

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Workflow to execute">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Select
            value={workflowId}
            onChange={(v) => onChange({ workflowId: v })}
            options={[
              { value: '', label: workflowId ? '—' : 'Select a workflow…' },
              ...options,
            ]}
          />
          <IconButton icon="ri-refresh-line" title="Reload workflows" onClick={reload} />
        </div>
      </Field>
      {loaded && workflows.length === 0 && (
        <p className="wf-form-note">No saved workflows yet — create one in the Workflows tab first.</p>
      )}

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
