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

import { Plus, Trash2 } from 'lucide-react'
import { Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { useEditorLocale } from '../../locale-context'
import { id } from './shared'

/** Primary action (the empty-state "add condition"). */
const ADD_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong'
/** Secondary actions (add AND row / add OR group). */
const ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-hover'

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
  {
    id: 'data#exists',
    category: 'value',
    name: 'Data exists',
    compareable: false,
    data: { dataPath: '' },
  },
  {
    id: 'element#text',
    category: 'element',
    name: 'Element text',
    compareable: true,
    data: { selector: '' },
  },
  {
    id: 'element#exists',
    category: 'element',
    name: 'Element exists',
    compareable: false,
    data: { selector: '' },
  },
  {
    id: 'element#notExists',
    category: 'element',
    name: 'Element not exists',
    compareable: false,
    data: { selector: '' },
  },
  {
    id: 'element#visible',
    category: 'element',
    name: 'Element visible',
    compareable: false,
    data: { selector: '' },
  },
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
  const { bt } = useEditorLocale()
  const valueDef = VALUE_TYPES.find((v) => v.id === item.type)

  const setType = (newType: string) => {
    const def = VALUE_TYPES.find((v) => v.id === newType)
    if (!def) return
    onChange({ ...item, type: newType, data: { ...def.data } })
  }
  const setData = (key: string, value: string) =>
    onChange({ ...item, data: { ...item.data, [key]: value } })

  // "code" renders a mono textarea; every other data key a plain input.
  const dataKeys = Object.keys(item.data).filter((k) => k !== 'context')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-40 shrink-0">
          <Select
            value={item.type}
            onChange={setType}
            options={VALUE_GROUPS.flatMap((g) =>
              g.items.map((v) => ({ value: v.id, label: v.name })),
            )}
          />
        </div>
        {item.type !== 'code' &&
          dataKeys.map((key) => (
            <div key={key} className="min-w-0 flex-1">
              <TextInput
                value={item.data[key] ?? ''}
                placeholder={INPUT_LABELS[key]?.placeholder ?? key}
                onChange={(v) => setData(key, v)}
              />
            </div>
          ))}
      </div>
      {item.type === 'code' && (
        <TextArea
          mono
          rows={4}
          value={item.data.code ?? ''}
          placeholder="// return true / false"
          onChange={(v) => setData('code', v)}
        />
      )}
      {valueDef && !valueDef.compareable && (
        <p className="wf-form-note m-0">{bt('Standalone condition — no comparison needed.')}</p>
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
  const firstValueDef =
    first && first.category === 'value' ? VALUE_TYPES.find((v) => v.id === first.type) : undefined
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

  const compareItem = row.items.find((i) => i.category === 'compare') as
    BuilderCompareItem | undefined

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
    <div className="rounded-lg border border-border bg-panel-2/40">
      <div className="flex items-center justify-end px-1.5 pt-1">
        <IconButton icon={Trash2} title="Delete condition" onClick={onDelete} />
      </div>
      <div className="flex flex-col gap-2 px-2.5 pb-2.5">
        {leftValue && (
          <>
            <ValueItemEditor
              item={leftValue}
              onChange={(n) => updateItem(row.items.indexOf(leftValue), n)}
            />
            {!standalone && (
              <>
                <Field label="Operator">
                  <Select
                    value={compareItem?.type ?? 'eq'}
                    onChange={setCompareType}
                    options={COMPARE_GROUPS.flatMap((g) =>
                      g.items.map((c) => ({ value: c.id, label: c.name })),
                    )}
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
  const { bt } = useEditorLocale()

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
    const nextGroups = groups.slice()
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
        <button type="button" className={ADD_BUTTON_CLASS} onClick={() => onChange([newOrGroup()])}>
          <Plus size={14} /> {bt('Add condition')}
        </button>
      )}

      {groups.map((group, gIndex) => (
        <div key={group.id} className="mb-3">
          <div className="flex gap-2.5">
            {/* Automa draws the AND group as a left rail with a badge, then
                the rows it joins. */}
            {group.conditions.length > 1 && (
              <div className="flex w-12 shrink-0 flex-col items-center pt-2">
                <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent">
                  AND
                </span>
                <span aria-hidden="true" className="mt-1 w-px flex-1 bg-accent/50" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {group.conditions.map((row, rIndex) => (
                <AndRow
                  key={row.id}
                  row={row}
                  onItemsChange={(items) => updateRowItems(gIndex, rIndex, items)}
                  onDelete={() => deleteRow(gIndex, rIndex)}
                />
              ))}
              <div className="flex gap-2">
                <button
                  type="button"
                  className={ACTION_BUTTON_CLASS}
                  onClick={() => addAndRow(gIndex)}
                >
                  <Plus size={13} /> AND
                </button>
                {gIndex === groups.length - 1 && (
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    onClick={() => onChange([...groups, newOrGroup()])}
                  >
                    <Plus size={13} /> OR
                  </button>
                )}
              </div>
            </div>
          </div>
          {gIndex !== groups.length - 1 && (
            <div className="my-2 flex items-center gap-2" aria-hidden="true">
              <span className="h-px flex-1 bg-accent/40" />
              <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
                OR
              </span>
              <span className="h-px flex-1 bg-accent/40" />
            </div>
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
