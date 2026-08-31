/**
 * ConditionBuilder — React port of Automa's SharedConditionBuilder
 * (`components/newtab/shared/SharedConditionBuilder/index.vue` +
 * `ConditionBuilderInputs.vue`, driven by `conditionBuilder` in
 * `utils/shared.js`).
 *
 * Data model (stored on `data.conditions`, either directly for while-loop or
 * inside each named path for the conditions block):
 *
 *   OrGroup[]  — outer list, ORed together
 *   OrGroup    = { id, conditions: AndItem[] }          // inner list, ANDed
 *   AndItem    = { id, items: BuilderItem[] }           // one "comparison row"
 *   BuilderItem:
 *     { id, category: 'value',   type: ValueType, data: { ...fields } }
 *     { id, category: 'compare', type: CompareType }
 *
 * A default row is [value, compare, value]: "left <op> right". A value item
 * whose type is not compareable (code / data-exists / element-exists / ...)
 * stands alone and drops the compare + right-hand value.
 *
 * @module workflow-editor/blocks/batchC/ConditionBuilder
 */

import { Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { id } from './shared'

// ---------------------------------------------------------------------------
// conditionBuilder's local value-type catalog (self-maintained, internal)
// ---------------------------------------------------------------------------

export interface ValueTypeDef {
  id: string
  category: 'value' | 'element'
  name: string
  compareable: boolean
  /** data keys created when this type is selected */
  data: Record<string, string>
}

export interface CompareTypeDef {
  id: string
  name: string
  needValue: boolean
  category: 'basic' | 'number' | 'text' | 'boolean'
}

export const VALUE_TYPES: ValueTypeDef[] = [
  { id: 'value', category: 'value', name: 'Value', compareable: true, data: { value: '' } },
  {
    id: 'code',
    category: 'value',
    name: 'Code',
    compareable: false,
    data: { code: '\nreturn true;', context: 'background' },
  },
  { id: 'data#exists', category: 'value', name: 'Data exists', compareable: false, data: { dataPath: '' } },
  { id: 'element#text', category: 'element', name: 'Element text', compareable: true, data: { selector: '' } },
  { id: 'element#exists', category: 'element', name: 'Element exists', compareable: false, data: { selector: '' } },
  { id: 'element#notExists', category: 'element', name: 'Element not exists', compareable: false, data: { selector: '' } },
  { id: 'element#visible', category: 'element', name: 'Element visible', compareable: false, data: { selector: '' } },
  {
    id: 'element#visibleScreen',
    category: 'element',
    name: 'Element visible in screen',
    compareable: false,
    data: { selector: '' },
  },
  {
    id: 'element#invisible',
    category: 'element',
    name: 'Element hidden in screen',
    compareable: false,
    data: { selector: '' },
  },
  {
    id: 'element#attribute',
    category: 'element',
    name: 'Element attribute value',
    compareable: true,
    data: { selector: '', attrName: '' },
  },
]

export const COMPARE_TYPES: CompareTypeDef[] = [
  { id: 'eq', name: 'Equals', needValue: true, category: 'basic' },
  { id: 'eqi', name: 'Equals (case insensitive)', needValue: true, category: 'basic' },
  { id: 'nq', name: 'Not equals', needValue: true, category: 'basic' },
  { id: 'gt', name: 'Greater than', needValue: true, category: 'number' },
  { id: 'gte', name: 'Greater than or equal', needValue: true, category: 'number' },
  { id: 'lt', name: 'Less than', needValue: true, category: 'number' },
  { id: 'lte', name: 'Less than or equal', needValue: true, category: 'number' },
  { id: 'cnt', name: 'Contains', needValue: true, category: 'text' },
  { id: 'cni', name: 'Contains (case insensitive)', needValue: true, category: 'text' },
  { id: 'nct', name: 'Not contains', needValue: true, category: 'text' },
  { id: 'nci', name: 'Not contains (case insensitive)', needValue: true, category: 'text' },
  { id: 'stw', name: 'Starts with', needValue: true, category: 'text' },
  { id: 'enw', name: 'Ends with', needValue: true, category: 'text' },
  { id: 'rgx', name: 'Match with RegEx', needValue: true, category: 'text' },
  { id: 'itr', name: 'Is truthy', needValue: false, category: 'boolean' },
  { id: 'ifl', name: 'Is falsy', needValue: false, category: 'boolean' },
]

const COMPARE_GROUPS: { label: string; items: CompareTypeDef[] }[] = (
  ['basic', 'number', 'text', 'boolean'] as const
).map((category) => ({
  label: category.charAt(0).toUpperCase() + category.slice(1),
  items: COMPARE_TYPES.filter((c) => c.category === category),
}))

const VALUE_GROUPS: { label: string; items: ValueTypeDef[] }[] = (
  ['value', 'element'] as const
).map((category) => ({
  label: category === 'value' ? 'Value' : 'Element',
  items: VALUE_TYPES.filter((v) => v.category === category),
}))

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export interface BuilderValueItem {
  id: string
  category: 'value'
  type: string
  data: Record<string, string>
}
export interface BuilderCompareItem {
  id: string
  category: 'compare'
  type: string
}
export type BuilderItem = BuilderValueItem | BuilderCompareItem

export interface AndItem {
  id: string
  items: BuilderItem[]
}
export interface OrGroup {
  id: string
  conditions: AndItem[]
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function newValueItem(): BuilderValueItem {
  return { id: id(), category: 'value', type: 'value', data: { value: '' } }
}
function newCompareItem(): BuilderCompareItem {
  return { id: id(), category: 'compare', type: 'eq' }
}

/** A fresh default row: [value, compare, value]. */
export function newAndItem(): AndItem {
  return { id: id(), items: [newValueItem(), newCompareItem(), newValueItem()] }
}
export function newOrGroup(): OrGroup {
  return { id: id(), conditions: [newAndItem()] }
}
/** While-loop's initial two AND rows (matches Automa's defaultConditions). */
export function defaultWhileConditions(): OrGroup[] {
  return [{ id: id(), conditions: [newAndItem(), newAndItem()] }]
}

// ---------------------------------------------------------------------------
// One value item (left/right operand): type select + its data inputs
// ---------------------------------------------------------------------------

const INPUT_LABELS: Record<string, { label: string; placeholder?: string }> = {
  value: { label: 'Value', placeholder: 'abc123' },
  selector: { label: 'CSS selector or XPath', placeholder: '.class' },
  attrName: { label: 'Attribute name', placeholder: 'name' },
  dataPath: { label: 'Data path', placeholder: 'variables@variableName' },
}

function ValueItemEditor({
  item,
  onChange,
}: {
  item: BuilderValueItem
  onChange: (next: BuilderValueItem) => void
}) {
  const valueDef = VALUE_TYPES.find((v) => v.id === item.type)

  const setType = (newType: string) => {
    const def = VALUE_TYPES.find((v) => v.id === newType)
    if (!def) return
    onChange({ ...item, type: newType, data: { ...def.data } })
  }
  const setData = (key: string, value: string) => onChange({ ...item, data: { ...item.data, [key]: value } })

  // "code" renders a mono textarea; every other data key a plain input.
  const dataKeys = Object.keys(item.data).filter((k) => k !== 'context')

  return (
    <div className="wf-field">
      <Select
        value={item.type}
        onChange={setType}
        options={VALUE_GROUPS.flatMap((g) => g.items.map((v) => ({ value: v.id, label: v.name })))}
      />
      {item.type === 'code' ? (
        <TextArea
          mono
          rows={4}
          value={item.data.code ?? ''}
          placeholder="// return true / false"
          onChange={(v) => setData('code', v)}
        />
      ) : (
        dataKeys.map((key) => (
          <TextInput
            key={key}
            value={item.data[key] ?? ''}
            placeholder={INPUT_LABELS[key]?.placeholder ?? key}
            onChange={(v) => setData(key, v)}
          />
        ))
      )}
      {valueDef && !valueDef.compareable && (
        <p className="wf-form-note">Standalone condition — no comparison needed.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One AND row: [left value] [compare] [right value]
// ---------------------------------------------------------------------------

function AndRow({
  row,
  onItemsChange,
  onDelete,
}: {
  row: AndItem
  onItemsChange: (items: BuilderItem[]) => void
  onDelete: () => void
}) {
  const first = row.items[0]
  const firstValueDef = first && first.category === 'value' ? VALUE_TYPES.find((v) => v.id === first.type) : undefined
  // A non-compareable left operand stands alone (Automa drops compare+right).
  const standalone = firstValueDef ? !firstValueDef.compareable : false

  const updateItem = (index: number, next: BuilderItem) => {
    const items = row.items.slice()
    items[index] = next
    if (index === 0 && next.category === 'value') {
      const def = VALUE_TYPES.find((v) => v.id === next.type)
      if (def && !def.compareable) items.splice(1) // drop compare + right value
    }
    onItemsChange(items)
  }

  const compareItem = row.items.find((i) => i.category === 'compare') as BuilderCompareItem | undefined

  const setCompareType = (newType: string) => {
    const def = COMPARE_TYPES.find((c) => c.id === newType)
    if (!def || !compareItem) return
    let items = row.items.slice()
    const compareIndex = items.indexOf(compareItem)
    items[compareIndex] = { ...compareItem, type: newType }
    if (!def.needValue) items = items.slice(0, compareIndex + 1)
    else if (items.length === 2) items.push(newValueItem())
    onItemsChange(items)
  }

  const valueItems = row.items.filter((i): i is BuilderValueItem => i.category === 'value')
  const [leftValue, rightValue] = valueItems

  return (
    <div className="wf-expand">
      <div className="wf-field" style={{ border: '1px solid var(--bc-border, #ccc)', borderRadius: 8, padding: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <IconButton icon="ri-delete-bin-line" title="Delete condition" onClick={onDelete} />
        </div>
        {leftValue && (
          <>
            <ValueItemEditor item={leftValue} onChange={(n) => updateItem(row.items.indexOf(leftValue), n)} />
            {!standalone && (
              <>
                <Field label="Operator">
                  <Select
                    value={compareItem?.type ?? 'eq'}
                    onChange={setCompareType}
                    options={COMPARE_GROUPS.flatMap((g) => g.items.map((c) => ({ value: c.id, label: c.name })))}
                  />
                </Field>
                {compareItem &&
                  COMPARE_TYPES.find((c) => c.id === compareItem.type)?.needValue !== false &&
                  rightValue && (
                    <ValueItemEditor
                      item={rightValue}
                      onChange={(n) => updateItem(row.items.indexOf(rightValue), n)}
                    />
                  )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Builder: OR groups of AND rows
// ---------------------------------------------------------------------------

export default function ConditionBuilder({
  value,
  onChange,
}: {
  value: OrGroup[]
  onChange: (next: OrGroup[]) => void
}) {
  const groups = value.length > 0 ? value : []

  const patchGroup = (groupIndex: number, next: OrGroup) => {
    const nextGroups = groups.slice()
    nextGroups[groupIndex] = next
    onChange(nextGroups)
  }

  const addAndRow = (groupIndex: number) => {
    const group = groups[groupIndex]
    if (!group) return
    patchGroup(groupIndex, { ...group, conditions: [...group.conditions, newAndItem()] })
  }

  const deleteRow = (groupIndex: number, rowIndex: number) => {
    const group = groups[groupIndex]
    if (!group) return
    const conditions = group.conditions.slice()
    conditions.splice(rowIndex, 1)
    let nextGroups = groups.slice()
    if (conditions.length === 0) {
      nextGroups.splice(groupIndex, 1) // remove empty OR group entirely
    } else {
      nextGroups[groupIndex] = { ...group, conditions }
    }
    onChange(nextGroups)
  }

  const updateRowItems = (groupIndex: number, rowIndex: number, items: BuilderItem[]) => {
    const group = groups[groupIndex]
    if (!group) return
    const conditions = group.conditions.slice()
    conditions[rowIndex] = { ...conditions[rowIndex]!, items }
    patchGroup(groupIndex, { ...group, conditions })
  }

  return (
    <div className="wf-form">
      {groups.length === 0 && (
        <button type="button" className="wf-btn-accent" onClick={() => onChange([newOrGroup()])}>
          <i className="ri-add-line" /> Add condition
        </button>
      )}

      {groups.map((group, gIndex) => (
        <div key={group.id} style={{ marginBottom: 12 }}>
          {group.conditions.length > 1 && (
            <p className="wf-form-note" style={{ fontWeight: 600 }}>
              <span
                style={{
                  display: 'inline-block',
                  minWidth: 40,
                  textAlign: 'center',
                  background: '#3b82f6',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '2px 0',
                  marginRight: 8,
                }}
              >
                AND
              </span>
              all rows below must match
            </p>
          )}
          {group.conditions.map((row, rIndex) => (
            <div key={row.id}>
              <AndRow
                row={row}
                onItemsChange={(items) => updateRowItems(gIndex, rIndex, items)}
                onDelete={() => deleteRow(gIndex, rIndex)}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="wf-btn-accent" onClick={() => addAndRow(gIndex)}>
              <i className="ri-add-line" /> AND
            </button>
            {gIndex === groups.length - 1 && (
              <button
                type="button"
                className="wf-btn-accent"
                onClick={() => onChange([...groups, newOrGroup()])}
              >
                <i className="ri-add-line" /> OR
              </button>
            )}
          </div>
          {gIndex !== groups.length - 1 && (
            <p style={{ textAlign: 'center', fontWeight: 700, margin: '8px 0' }}>
              <span
                style={{
                  background: '#6366f1',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '2px 12px',
                }}
              >
                OR
              </span>
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

/** Coerce raw block data into an OrGroup[] ([] when absent/empty). */
export function readGroups(raw: unknown): OrGroup[] {
  return Array.isArray(raw) ? (raw as OrGroup[]) : []
}
