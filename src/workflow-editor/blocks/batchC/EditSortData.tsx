/**
 * EditSortData — React port of Automa's EditSortData.vue.
 *
 * Sorts table rows or a variable's items, optionally by named item
 * properties (up to 3, each ascending/descending). Fields: dataSource
 * ('table' | 'variable'), varSourceName, sortByProperty, itemProperties[]
 * (`{ name, order: 'asc' | 'desc' }`), plus the save/variable output strip.
 *
 * @module workflow-editor/blocks/batchC/EditSortData
 */

import { Field, IconButton, Select, Switch, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { AssignVariable, SaveToTable, arr } from './shared'

interface SortProperty {
  name: string
  order: 'asc' | 'desc'
}

function readProperties(raw: unknown): SortProperty[] {
  return arr<SortProperty>(raw).map((p) => ({
    name: typeof p.name === 'string' ? p.name : '',
    order: p.order === 'desc' ? 'desc' : 'asc',
  }))
}

export default function EditSortData({ data, onChange }: EditFormProps) {
  const dataSource = str(data, 'dataSource') || 'table'
  const sortByProperty = bool(data, 'sortByProperty')
  const properties = readProperties(data.itemProperties)

  const commitProperties = (next: SortProperty[]) => onChange({ itemProperties: next })

  const addProperty = () => {
    if (properties.length >= 3) return
    commitProperties([...properties, { name: '', order: 'asc' }])
  }
  const removeProperty = (index: number) => {
    const next = properties.slice()
    next.splice(index, 1)
    commitProperties(next)
  }
  const patchProperty = (index: number, patch: Partial<SortProperty>) => {
    const next = properties.slice()
    next[index] = { ...next[index]!, ...patch }
    commitProperties(next)
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

      <Field label="Data source">
        <Select
          value={dataSource}
          onChange={(v) => onChange({ dataSource: v })}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'variable', label: 'Variable' },
          ]}
        />
      </Field>

      {dataSource === 'variable' && (
        <Field label="Variable name" title="Variable name">
          <TextInput value={str(data, 'varSourceName')} placeholder="abc123" onChange={(v) => onChange({ varSourceName: v })} />
        </Field>
      )}

      <Switch
        checked={sortByProperty}
        onChange={(v) => onChange({ sortByProperty: v })}
        label="Sort by the item's property"
      />

      {sortByProperty && (
        <div style={{ marginTop: 8 }}>
          {properties.map((property, index) => (
            <div
              key={index}
              style={{ borderBottom: '1px solid var(--bc-border, #ccc)', paddingBottom: 8, marginBottom: 8 }}
            >
              <TextInput
                value={property.name}
                placeholder={`Property ${index + 1}`}
                onChange={(v) => patchProperty(index, { name: v })}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <div style={{ flex: 1 }}>
                  <Select
                    value={property.order}
                    onChange={(v) => patchProperty(index, { order: v === 'desc' ? 'desc' : 'asc' })}
                    options={[
                      { value: 'asc', label: 'Ascending' },
                      { value: 'desc', label: 'Descending' },
                    ]}
                  />
                </div>
                <IconButton icon="ri-delete-bin-line" title="Remove property" onClick={() => removeProperty(index)} />
              </div>
            </div>
          ))}
          {properties.length < 3 && (
            <button type="button" className="wf-btn-accent" onClick={addProperty}>
              <i className="ri-add-line" /> Add property
            </button>
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <SaveToTable data={data} onChange={onChange} />
        <AssignVariable data={data} onChange={onChange} />
      </div>
    </div>
  )
}
