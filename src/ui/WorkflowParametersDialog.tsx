/**
 * The workflow panel's parameter editor: set the values a `parameter-prompt`
 * block would otherwise ask for at run time.
 *
 * Values are raw form text keyed by parameter name and persisted on the
 * workflow (`Workflow.parameterValues`). A saved value seeds the run and tells
 * the prompt block not to ask again, which is what makes scheduled runs — with
 * nobody to answer a dialog — able to use a configured workflow.
 *
 * Secret parameters are listed but NOT editable here. A credential must never
 * enter the workflow definition: the definition is exported, downloaded and
 * shown to the assistant, while a secret is meant to be typed at run time or
 * resolved by a `get-secret` block.
 *
 * Presentational only: persistence and copy belong to the hosting surface.
 *
 * @module ui/WorkflowParametersDialog
 */

import { useId, useState } from 'react'
import { Eraser, Trash2 } from 'lucide-react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from './FormDialog'
import { RunInputFieldControl, validateRunInput, type RunInputDialogLabels } from './RunInputDialog'
import type { RunInputField, RunInputFieldType } from '../lib/workflow/run-input'
import type { WorkflowParameter } from '../lib/workflow/types'

export interface WorkflowParametersDialogLabels {
  title: string
  /** Shown under the title: which workflow these values belong to. */
  workflow: (name: string) => string
  hint: string
  save: string
  cancel: string
  /** Clears every saved value. */
  clearAll: string
  /** Per-field clear, used as the icon button's label. */
  clearField: (name: string) => string
  empty: string
  secretHint: string
  /** Marks a field that has no value yet ("not set"). */
  unset: string
  requiredMark: string
  requiredField: (name: string) => string
  invalidJson: string
}

export interface WorkflowParametersDialogProps {
  workflowName: string
  parameters: readonly WorkflowParameter[]
  /** The workflow's saved raw values. */
  values: Readonly<Record<string, string>>
  labels: WorkflowParametersDialogLabels
  busy?: boolean
  onSave: (values: Record<string, string>) => void
  onClose: () => void
}

function fieldTypeOf(param: WorkflowParameter): RunInputFieldType {
  const known: readonly string[] = ['string', 'number', 'json', 'checkbox']
  return (known.includes(param.type) ? param.type : 'string') as RunInputFieldType
}

/** The form fields for these declarations, blank ones included. */
export function parameterFieldsOf(
  parameters: readonly WorkflowParameter[],
  values: Readonly<Record<string, string>>,
): RunInputField[] {
  return parameters.map((param) => ({
    name: param.name,
    type: fieldTypeOf(param),
    ...(param.placeholder ? { placeholder: param.placeholder } : {}),
    value: values[param.name] ?? '',
    required: false,
  }))
}

/**
 * What actually gets persisted: declared, non-secret values only, and only
 * non-empty ones (blank means "not configured").
 *
 * Filtering by declaration matters — a value left over from a removed or
 * recently-secret parameter must not stay in the workflow definition, because
 * that definition is exported and read by the assistant.
 */
export function declaredParameterValues(
  parameters: readonly WorkflowParameter[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const param of parameters) {
    if (param.secret === true) continue
    const value = values[param.name]
    if (value !== undefined && value !== '') out[param.name] = value
  }
  return out
}

export default function WorkflowParametersDialog({
  workflowName,
  parameters,
  values,
  labels,
  busy = false,
  onSave,
  onClose,
}: WorkflowParametersDialogProps): React.ReactElement {
  const baseId = useId()
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...values }))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const editable = parameters.filter((param) => param.secret !== true)

  const change = (name: string, next: string): void => {
    setDraft((previous) => {
      const updated = { ...previous }
      if (next === '') delete updated[name]
      else updated[name] = next
      return updated
    })
    setErrors((previous) => {
      if (!(name in previous)) return previous
      const remaining = { ...previous }
      delete remaining[name]
      return remaining
    })
  }

  const clearField = (name: string): void => {
    setDraft((previous) => {
      const updated = { ...previous }
      delete updated[name]
      return updated
    })
  }

  const submit = (): void => {
    // Validate exactly what the run-time dialog validates, so a JSON value that
    // would be rejected there cannot be saved here. Requiredness is not checked:
    // leaving a field blank means "ask me at run time", not an error.
    const validationLabels: Pick<RunInputDialogLabels, 'requiredField' | 'invalidJson'> = {
      requiredField: labels.requiredField,
      invalidJson: labels.invalidJson,
    }
    const found = validateRunInput(parameterFieldsOf(editable, draft), draft, validationLabels)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    onSave(declaredParameterValues(parameters, draft))
  }

  return (
    <FormDialog onClose={onClose} title={labels.title} width="md">
      <p className="m-0 text-[12px] text-muted">{labels.workflow(workflowName)}</p>
      <p className="m-0 mt-2 text-[12px] leading-snug text-muted">{labels.hint}</p>
      {parameters.length === 0 ? (
        <p className="m-0 mt-3 text-[12px] text-faint">{labels.empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {parameters.map((param, index) => {
            const inputId = `${baseId}-param-${index}`
            const configured = draft[param.name] !== undefined && draft[param.name] !== ''
            return (
              <div key={`${param.name}-${index}`}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <label className="text-[12px] font-medium text-ink" htmlFor={inputId}>
                    {param.name}
                  </label>
                  <div className="flex items-center gap-2">
                    {param.data?.['required'] === true ? (
                      <span className="text-[10px] uppercase tracking-wide text-muted">
                        {labels.requiredMark}
                      </span>
                    ) : null}
                    {param.secret === true ? null : configured ? (
                      <button
                        aria-label={labels.clearField(param.name)}
                        className="cursor-pointer rounded border-0 bg-transparent p-0.5 text-faint hover:text-err"
                        onClick={() => clearField(param.name)}
                        title={labels.clearField(param.name)}
                        type="button"
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className="text-[10px] text-faint">{labels.unset}</span>
                    )}
                  </div>
                </div>
                {param.description && (
                  <p className="m-0 mb-1 text-[11px] leading-snug text-muted">
                    {param.description}
                  </p>
                )}
                {param.secret === true ? (
                  <p className="m-0 text-[11px] text-faint">{labels.secretHint}</p>
                ) : (
                  <>
                    <RunInputFieldControl
                      field={parameterFieldsOf([param], draft)[0]!}
                      hideName
                      inputId={inputId}
                      onChange={(next) => change(param.name, next)}
                      value={draft[param.name] ?? ''}
                    />
                    {errors[param.name] && (
                      <p className="m-0 mt-1 text-[11px] text-err">{errors[param.name]}</p>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-panel-2 px-3 py-1.5 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busy || !editable.some((param) => (draft[param.name] ?? '') !== '')}
          onClick={() => setDraft({})}
          type="button"
        >
          <Eraser aria-hidden className="h-3.5 w-3.5" />
          {labels.clearAll}
        </button>
        <div className="flex gap-2">
          <FormDialogCancelButton disabled={busy} label={labels.cancel} onClick={onClose} />
          <FormDialogPrimaryButton disabled={busy} label={labels.save} onClick={submit} />
        </div>
      </div>
    </FormDialog>
  )
}
