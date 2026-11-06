/**
 * The runtime dialog for a `parameter-prompt` block (Automa's parameter popup).
 *
 * Presentational only: it receives the prompt, renders one control per declared
 * parameter, validates the answer and reports it. Copy comes from the hosting
 * surface (workflow editor / side panel), so this file stays out of i18n.
 *
 * Escape and a backdrop click deliberately do NOT close it: dismissing a
 * blocking prompt can only mean "stop the run", and a stray click should never
 * kill a run that is waiting on a value. Stopping is its own button.
 *
 * @module ui/RunInputDialog
 */

import { useId, useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from './FormDialog'
import type { RunInputField, RunInputRequest } from '../lib/workflow/run-input'

export interface RunInputDialogLabels {
  title: string
  workflow: (name: string) => string
  submit: string
  stop: string
  requiredMark: string
  requiredField: (name: string) => string
  invalidJson: string
  secretHint: string
  timeoutHint: (seconds: number) => string
}

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-sunken px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent'

/** Required/type validation; returns one message per offending field. */
export function validateRunInput(
  fields: readonly RunInputField[],
  values: Readonly<Record<string, string>>,
  labels: Pick<RunInputDialogLabels, 'requiredField' | 'invalidJson'>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const raw = values[field.name] ?? ''
    const blank = raw.trim() === ''
    // A secret never travels to the page, so a blank field means "keep the
    // stored value" — acceptable only when something is stored.
    const keepsStoredSecret = field.secret === true && blank && field.secretStored === true
    if (field.required && blank && !keepsStoredSecret) {
      errors[field.name] = labels.requiredField(field.name)
      continue
    }
    if (field.type === 'json' && !blank) {
      try {
        JSON.parse(raw)
      } catch {
        errors[field.name] = labels.invalidJson
      }
    }
  }
  return errors
}

function FieldControl({
  field,
  inputId,
  value,
  onChange,
}: {
  field: RunInputField
  inputId: string
  value: string
  onChange: (next: string) => void
}): React.ReactElement {
  if (field.type === 'checkbox') {
    return (
      <label
        className="flex cursor-pointer items-center gap-2 text-[13px] text-ink"
        htmlFor={inputId}
      >
        <input
          checked={value === 'true'}
          className="h-3.5 w-3.5 accent-accent"
          id={inputId}
          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
          type="checkbox"
        />
        <span>{field.name}</span>
      </label>
    )
  }
  if (field.type === 'json') {
    return (
      <textarea
        className={`${INPUT_CLASS} min-h-[92px] font-mono text-[12px]`}
        id={inputId}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder ?? '{}'}
        spellCheck={false}
        value={value}
      />
    )
  }
  return (
    <input
      autoComplete={field.secret === true ? 'new-password' : 'off'}
      className={INPUT_CLASS}
      id={inputId}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder ?? ''}
      type={field.secret === true ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={value}
    />
  )
}

export default function RunInputDialog({
  request,
  labels,
  onSubmit,
  onCancel,
}: {
  request: RunInputRequest
  labels: RunInputDialogLabels
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}): React.ReactElement {
  const baseId = useId()
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of request.fields) initial[field.name] = field.value
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const change = (name: string, next: string): void => {
    setValues((prev) => ({ ...prev, [name]: next }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const remaining = { ...prev }
      delete remaining[name]
      return remaining
    })
  }

  const submit = (): void => {
    const found = validateRunInput(request.fields, values, labels)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    onSubmit(values)
  }

  return (
    <FormDialog
      // A blocking prompt has no "dismiss" outcome; see the module comment.
      onClose={() => {}}
      title={labels.title}
      width="md"
    >
      <p className="m-0 text-[12px] text-muted">{labels.workflow(request.workflowName)}</p>
      {request.description && (
        <p className="mt-2 mb-0 whitespace-pre-wrap text-[13px] text-ink">{request.description}</p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {request.fields.map((field, index) => {
          const inputId = `${baseId}-field-${index}`
          return (
            <div key={`${field.name}-${index}`}>
              {field.type !== 'checkbox' && (
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <label className="text-[12px] font-medium text-ink" htmlFor={inputId}>
                    {field.name}
                  </label>
                  {field.required && (
                    <span className="text-[10px] uppercase tracking-wide text-muted">
                      {labels.requiredMark}
                    </span>
                  )}
                </div>
              )}
              {field.description && (
                <p className="m-0 mb-1 text-[11px] leading-snug text-muted">{field.description}</p>
              )}
              <FieldControl
                field={field}
                inputId={inputId}
                onChange={(next) => change(field.name, next)}
                value={values[field.name] ?? ''}
              />
              {field.secret === true && (
                <p className="m-0 mt-1 text-[11px] text-faint">{labels.secretHint}</p>
              )}
              {errors[field.name] && (
                <p className="m-0 mt-1 text-[11px] text-err">{errors[field.name]}</p>
              )}
            </div>
          )
        })}
      </div>
      <p className="m-0 mt-3 text-[11px] text-faint">
        {labels.timeoutHint(Math.max(1, Math.round(request.timeoutMs / 1000)))}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <FormDialogCancelButton label={labels.stop} onClick={onCancel} />
        <FormDialogPrimaryButton label={labels.submit} onClick={submit} />
      </div>
    </FormDialog>
  )
}
