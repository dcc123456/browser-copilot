/**
 * EditInsertData — React port of Automa's EditInsertData.vue.
 *
 * Inserts a list of values into table columns or variables (`data.dataList`,
 * items shaped `{ type: 'table' | 'variable', name, value, ... }`). The Vue
 * form edits this list inside a modal and supports file imports (path, base64,
 * CSV/XLSX parsing via Papa/xlsx). File access is out of scope here; each item
 * offers a type select, a name (variable name or table column — a text field
 * since live columns aren't available in the editor), and a value textarea.
 *
 * @module workflow-editor/blocks/batchC/EditInsertData
 */

import { useState } from 'react'
import { Field, IconButton, Select, TextArea } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { arr, id } from './shared'

interface InsertItem {
  type: 'table' | 'variable'
  name: string
  value: string
  filePath?: string
  isFile?: boolean
  action?: string
  [key: string]: unknown
}

function readList(raw: unknown): InsertItem[] {
  return arr<InsertItem>(raw).map((it) => ({
    type: it.type === 'variable' ? 'variable' : 'table',
    name: typeof it.name === 'string' ? it.name : '',
    value: typeof it.value === 'string' ? it.value : '',
    filePath: typeof it.filePath === 'string' ? it.filePath : '',
    isFile: it.isFile === true,
    action: typeof it.action === 'string' ? it.action : 'default',
  }))
}

export default function EditInsertData({ data, onChange }: EditFormProps) {
  const [open, setOpen] = useState(false)
  const list = readList(data.dataList)

  const commit = (next: InsertItem[]) => onChange({ dataList: next })

  const addItem = () => commit([...list, { type: 'table', name: '', value: '', filePath: '', isFile: false, action: 'default', id: id(6) }])
  const removeItem = (index: number) => {
    const next = list.slice()
    next.splice(index, 1)
    commit(next)
  }
  const changeType = (index: number, type: 'table' | 'variable') => {
    const next = list.slice()
    next[index] = { ...next[index]!, type, name: '' }
    commit(next)
  }
  const patchItem = (index: number, patch: Partial<InsertItem>) => {
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

      <button type="button" className="wf-btn-accent w-full" onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Insert data'} ({list.length})
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {list.map((item, index) => (
            <div
              key={index}
              style={{ border: '1px solid var(--bc-border, #ccc)', borderRadius: 8, padding: 8, marginBottom: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: '0 0 130px' }}>
                  <Select
                    value={item.type}
                    onChange={(v) => changeType(index, v === 'variable' ? 'variable' : 'table')}
                    options={[
                      { value: 'table', label: 'Table' },
                      { value: 'variable', label: 'Variable' },
                    ]}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={item.type === 'variable' ? 'Variable name' : 'Table column'}>
                    <input
                      type="text"
                      value={item.name}
                      placeholder={item.type === 'variable' ? 'abc123' : 'Column id / name'}
                      onChange={(e) => patchItem(index, { name: e.target.value })}
                    />
                  </Field>
                </div>
                <IconButton icon="ri-delete-bin-line" title="Remove item" onClick={() => removeItem(index)} />
              </div>
              <Field label="Value">
                <TextArea
                  rows={2}
                  value={item.value}
                  placeholder="value"
                  onChange={(v) => patchItem(index, { value: v })}
                />
              </Field>
            </div>
          ))}
          <button type="button" className="wf-btn-accent" onClick={addItem}>
            <i className="ri-add-line" /> Add
          </button>
          <p className="wf-form-note">File import (path / CSV / Excel / base64) is not supported in this build.</p>
        </div>
      )}
    </div>
  )
}
