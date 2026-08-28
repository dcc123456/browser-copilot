/**
 * Workflow info fields — the workflow's NAME, DESCRIPTION and run SETTINGS,
 * edited on the TRIGGER block.
 *
 * In Automa the workflow-level configuration (name, description, debug/log/
 * notification settings) lives with the trigger / workflow settings rather than
 * a separate sidebar tab, so Browser Copilot now shows this on the trigger
 * block — the single block that represents "how this workflow starts and is
 * configured". The editor keeps workflow meta as the source of truth and passes
 * it in plus an `onMeta` patch channel (see {@link useWorkflowMetaContext}).
 *
 * When no meta context is present (e.g. the form is rendered somewhere without
 * a workflow), the fields render read-only/hidden gracefully.
 *
 * @module workflow-editor/blocks/batchD/WorkflowInfoFields
 */

import { createContext, useContext, type ReactNode } from 'react'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'

export interface WorkflowMetaPatch {
  name?: string
  description?: string
  settings?: Partial<{ debugMode: boolean; saveLog: boolean; notification: boolean }>
}

export interface WorkflowMetaLike {
  name: string
  description: string
  settings: { debugMode: boolean; saveLog: boolean; notification: boolean }
}

const WorkflowMetaContext = createContext<{
  meta: WorkflowMetaLike
  onMeta: (patch: WorkflowMetaPatch) => void
} | null>(null)

/** Provide the live workflow meta to block forms (the trigger form consumes it). */
export function WorkflowMetaProvider({
  meta,
  onMeta,
  children,
}: {
  meta: WorkflowMetaLike
  onMeta: (patch: WorkflowMetaPatch) => void
  children: ReactNode
}) {
  return <WorkflowMetaContext.Provider value={{ meta, onMeta }}>{children}</WorkflowMetaContext.Provider>
}

export function useWorkflowMeta(): { meta: WorkflowMetaLike; onMeta: (patch: WorkflowMetaPatch) => void } | null {
  return useContext(WorkflowMetaContext)
}

export default function WorkflowInfoFields() {
  const ctx = useWorkflowMeta()
  if (!ctx) return null
  const { meta, onMeta } = ctx
  const setSetting = (key: 'debugMode' | 'saveLog' | 'notification', value: boolean) =>
    onMeta({ settings: { ...meta.settings, [key]: value } })

  return (
    <div className="wf-workflow-info">
      <Field label="Workflow name">
        <TextInput value={meta.name} placeholder="My workflow" onChange={(v) => onMeta({ name: v })} />
      </Field>
      <Field label="Description">
        <TextArea
          value={meta.description}
          rows={2}
          placeholder="What does this workflow do?"
          onChange={(v) => onMeta({ description: v })}
        />
      </Field>

      <div className="wf-section-title">Run settings</div>
      <Checkbox
        checked={meta.settings.saveLog}
        onChange={(v) => setSetting('saveLog', v)}
        label="Save execution logs"
      />
      <Checkbox
        checked={meta.settings.notification}
        onChange={(v) => setSetting('notification', v)}
        label="Notify when finished"
      />
    </div>
  )
}
