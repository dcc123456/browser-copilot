/**
 * EditSetVariable — edit form for the local `set-variable` block.
 *
 * One node writes one OR SEVERAL variables: the form is a row list of
 * (name · value) pairs. Rows apply top to bottom, so a later row can reference
 * a variable an earlier row just wrote. The stored shape lives in
 * `lib/workflow/block-output` (`variables[]`, with the legacy `variableName` +
 * `value` pair accepted when `variables` is empty).
 *
 * @module workflow-editor/blocks/batchC/EditSetVariable
 */

import { Plus, Trash2 } from 'lucide-react'
import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import type { EditFormProps } from '../EditForms'

interface VariableRow {
  name: string
  value: string
}

const EMPTY_ROW: VariableRow = { name: '', value: '' }

/** Rows to render: stored rows, else the legacy single pair, else one blank row. */
function rowsOf(data: Record<string, unknown>): VariableRow[] {
  const stored = Array.isArray(data['variables']) ? data['variables'] : []
  const rows = stored.flatMap((row): VariableRow[] => {
    if (!row || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    return [
      {
        name: typeof record['name'] === 'string' ? record['name'] : '',
        value: typeof record['value'] === 'string' ? record['value'] : '',
      },
    ]
  })
  if (rows.length > 0) return rows
  const legacyName = str(data, 'variableName')
  const legacyValue = typeof data['value'] === 'string' ? data['value'] : ''
  if (legacyName !== '' || legacyValue !== '') {
    return [{ name: legacyName, value: legacyValue }]
  }
  return [EMPTY_ROW]
}

export default function EditSetVariable({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  // Keeping blank rows in storage is harmless (`variableAssignmentsOf` skips
  // nameless rows) and lets "add" show an empty row without a local draft.
  const rows = rowsOf(data)
  const commit = (next: VariableRow[]): void =>
    onChange({
      variables: next.length > 0 ? next : [EMPTY_ROW],
      variableName: '',
      value: '',
    })
  const patchRow = (index: number, patch: Partial<VariableRow>): void =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Variables">
        <div className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <div
              className="flex flex-col gap-1 rounded-md border border-border bg-panel p-2"
              key={index}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1">
                  <TextInput
                    value={row.name}
                    placeholder="Variable name — e.g. accessToken"
                    onChange={(name) => patchRow(index, { name })}
                    noSlash
                  />
                </span>
                <button
                  type="button"
                  className="ml-auto rounded-md p-1 text-muted hover:bg-hover hover:text-err"
                  onClick={() => commit(rows.filter((_, i) => i !== index))}
                  title={bt('Remove variable')}
                  aria-label={bt('Remove variable')}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <TextArea
                value={row.value}
                rows={1}
                placeholder="Value — supports {{variables}}"
                onChange={(value) => patchRow(index, { value })}
              />
            </div>
          ))}
          <button
            type="button"
            className="wf-params-add"
            onClick={() => commit([...rows, EMPTY_ROW])}
          >
            <Plus size={14} />
            <span>{bt('Add variable')}</span>
          </button>
        </div>
      </Field>

      <p className="wf-form-note">
        {bt(
          'Each row sets one workflow variable for later blocks. Rows run top to bottom, so a later value can reference a variable set above it.',
        )}
      </p>
    </div>
  )
}
