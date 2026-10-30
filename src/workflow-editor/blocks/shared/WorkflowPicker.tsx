/**
 * Saved-workflow dropdown shared by every block form that references another
 * workflow (execute-workflow, log-data).
 *
 * The workflow store lives in the service worker, so the list is read through
 * `workflows.list` and can be refreshed from the button next to the select.
 * A stored id that no longer resolves (deleted workflow, or a value written by
 * an older build) still renders as an option, so opening and saving the form
 * never silently rewrites it.
 *
 * @module workflow-editor/blocks/shared/WorkflowPicker
 */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../../../lib/messages'
import type { Workflow } from '../../../lib/workflow/types'
import { useEditorLocale } from '../../locale-context'
import { Field, IconButton, Select } from './Field'

export function useWorkflowOptions(excludeId?: string | null): {
  workflows: Workflow[]
  loaded: boolean
  reload: () => void
} {
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

  return {
    workflows: excludeId ? workflows.filter((workflow) => workflow.id !== excludeId) : workflows,
    loaded,
    reload,
  }
}

export default function WorkflowPicker({
  label,
  value,
  onChange,
  excludeId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  /** Workflow being edited; self-execution is a guaranteed loop. */
  excludeId?: string | null
}) {
  const { bt } = useEditorLocale()
  const { workflows, loaded, reload } = useWorkflowOptions(excludeId)

  const options = workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))
  if (value && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: value })
  }

  return (
    <>
      <Field label={label}>
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Select
              value={value}
              onChange={onChange}
              options={[{ value: '', label: value ? '—' : 'Select a workflow…' }, ...options]}
            />
          </div>
          <IconButton icon={RefreshCw} title="Reload workflows" onClick={reload} />
        </div>
      </Field>
      {loaded && workflows.length === 0 && (
        <p className="wf-form-note">
          {bt('No saved workflows yet — create one in the Workflows tab first.')}
        </p>
      )}
    </>
  )
}
