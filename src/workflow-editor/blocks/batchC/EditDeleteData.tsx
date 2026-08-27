/**
 * EditDeleteData — React port of Automa's EditDeleteData.vue.
 *
 * Deletes table columns (or all columns) and/or variables (`data.deleteList`,
 * items shaped `{ type: 'table' | 'variable', columnId?, variableName? }`).
 * Table column names normally come from the workflow's table schema; without
 * that in the editor the table target is a [All columns] / [Column] select
 * followed by a free-text column id, matching Automa's field names.
 *
 * @module workflow-editor/blocks/batchC/EditDeleteData
 */

import { Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { arr } from './shared'

interface DeleteItem {
  type: 'table' | 'variable'
  variableName: string
  columnId: string
}

function readList(raw: unknown): DeleteItem[] {
  return arr<DeleteItem>(raw).map((it) => ({
    type: it.type === 'variable' ? 'variable' : 'table',
    variableName: typeof it.variableName === 'string' ? it.variableName : '',
    columnId: typeof it.columnId === 'string' ? it.columnId : '[all]',
  }))
}

export default function EditDeleteData({ data, onChange }: EditFormProps) {
  const list = readList(data.deleteList)

  const commit = (next: DeleteItem[]) => onChange({ deleteList: next })

  const addItem = () => commit([...list, { type: 'table', variableName: '', columnId: '[all]' }])
  const removeItem = (index: number) => {
    const next = list.slice()
    next.splice(index, 1)
    commit(next)
  }
  const patchItem = (index: number, patch: Partial<DeleteItem>) => {
    const next = list.slice()
    next[index] = { ...next[index]!, ...patch }
    commit(next)
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

      {list.map((item, index) => (
        <div
          key={index}
          style={{ borderBottom: '1px solid var(--bc-border, #ccc)', paddingBottom: 12, marginBottom: 12 }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label="Data from">
                <Select
                  value={item.type}
                  onChange={(v) => patchItem(index, { type: v === 'variable' ? 'variable' : 'table' })}
                  options={[
                    { value: 'table', label: 'Table' },
                    { value: 'variable', label: 'Variable' },
                  ]}
                />
              </Field>
            </div>
            <IconButton icon="ri-delete-bin-line" title="Remove" onClick={() => removeItem(index)} />
          </div>

          {item.type === 'variable' ? (
            <Field label="Variable name" title="Variable name">
              <TextInput
                value={item.variableName}
                placeholder="abc123"
                onChange={(v) => patchItem(index, { variableName: v })}
              />
            </Field>
          ) : (
            <Field label="Column">
              <Select
                value={item.columnId === '[all]' ? '[all]' : 'column'}
                onChange={(v) => patchItem(index, { columnId: v === '[all]' ? '[all]' : '' })}
                options={[
                  { value: '[all]', label: '[All columns]' },
                  { value: 'column', label: 'Column' },
                ]}
              />
              {item.columnId !== '[all]' && (
                <TextInput
                  value={item.columnId}
                  placeholder="Column id / name"
                  onChange={(v) => patchItem(index, { columnId: v })}
                />
              )}
            </Field>
          )}
        </div>
      ))}

      <button type="button" className="wf-btn-accent" onClick={addItem}>
        <i className="ri-add-line" /> Add
      </button>
    </div>
  )
}
