/**
 * Condition editor — editable rows for {@link WorkflowCondition}.
 *
 * Supports the condition kinds that map to a small form (URL, element,
 * variable); element targets use a semantic locator (role + accessible name).
 * Used by {@link NodeGoalInspector} so users can manually add and edit a node's
 * success criteria instead of only reading a rendered summary.
 *
 * Pure presentation: every change is normalised through the condition guard
 * before it is reported, so the parent always receives a valid condition.
 *
 * @module workflow-editor/sidebar/ConditionEditor
 */

import { Plus, Trash2 } from 'lucide-react'
import type { WorkflowCondition } from '../../lib/workflow/conditions'
import {
  conditionTargetName,
  withConditionTargetName,
} from '../../lib/workflow/element-fingerprint'
import type { TranslateFn } from '../i18n'

/** Condition kinds offered in the manual editor. */
export const EDITABLE_CONDITION_KINDS = [
  'elementVisible',
  'elementExists',
  'elementText',
  'urlContains',
  'variableExists',
  'variableEquals',
] as const

const inputClass =
  'min-w-0 flex-1 rounded-md border border-border bg-panel px-2 py-1 text-xs text-ink outline-none focus:border-accent'
const selectClass =
  'rounded-md border border-border bg-panel px-1.5 py-1 text-xs text-ink outline-none focus:border-accent'

/** Build a blank valid-ish draft for a kind (fields filled by the user). */
function blankCondition(kind: string): WorkflowCondition {
  switch (kind) {
    case 'urlContains':
      return { kind: 'urlContains', value: '' }
    case 'elementExists':
      return { kind: 'elementExists', target: { accessibleName: '' } }
    case 'elementText':
      return {
        kind: 'elementText',
        target: { accessibleName: '' },
        expected: '',
        match: 'contains',
      }
    case 'variableExists':
      return { kind: 'variableExists', name: '' }
    case 'variableEquals':
      return { kind: 'variableEquals', name: '', expected: '' }
    case 'elementVisible':
    default:
      return { kind: 'elementVisible', target: { accessibleName: '' } }
  }
}

/** Read the accessible-name field off a locator-bearing condition. */
function nameOf(condition: WorkflowCondition): string {
  if (!('target' in condition)) return ''
  return conditionTargetName(condition.target)
}

function ConditionRow({
  condition,
  onPatch,
  onRemove,
  t,
}: {
  condition: WorkflowCondition
  onPatch: (next: WorkflowCondition) => void
  onRemove: () => void
  t: TranslateFn
}) {
  const setName = (accessibleName: string) => {
    if (!('target' in condition)) return
    onPatch({ ...condition, target: withConditionTargetName(condition.target, accessibleName) })
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-panel p-2">
      <div className="flex items-center gap-1.5">
        <select
          className={selectClass}
          value={condition.kind}
          onChange={(e) => onPatch(blankCondition(e.target.value))}
          aria-label={t('nodeConditionKind')}
        >
          {EDITABLE_CONDITION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`nodeConditionKind_${kind}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ml-auto rounded-md p-1 text-muted hover:bg-hover hover:text-err"
          onClick={onRemove}
          aria-label={t('nodeConditionRemove')}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {(condition.kind === 'elementVisible' ||
          condition.kind === 'elementExists' ||
          condition.kind === 'elementText') && (
          <input
            className={inputClass}
            type="text"
            placeholder={t('nodeConditionElementName')}
            value={nameOf(condition)}
            onChange={(e) => setName(e.target.value)}
          />
        )}

        {condition.kind === 'elementText' && (
          <input
            className={inputClass}
            type="text"
            placeholder={t('nodeConditionExpectedText')}
            value={condition.expected}
            onChange={(e) => onPatch({ ...condition, expected: e.target.value })}
          />
        )}

        {condition.kind === 'urlContains' && (
          <input
            className={inputClass}
            type="text"
            placeholder={t('nodeConditionUrlValue')}
            value={condition.value}
            onChange={(e) => onPatch({ ...condition, value: e.target.value })}
          />
        )}

        {(condition.kind === 'variableExists' ||
          condition.kind === 'variableEquals') && (
          <input
            className={inputClass}
            type="text"
            placeholder={t('nodeConditionVariableName')}
            value={condition.name}
            onChange={(e) => onPatch({ ...condition, name: e.target.value })}
          />
        )}

        {condition.kind === 'variableEquals' && (
          <input
            className={inputClass}
            type="text"
            placeholder={t('nodeConditionExpectedValue')}
            value={
              typeof condition.expected === 'string' ? condition.expected : ''
            }
            onChange={(e) =>
              onPatch({ ...condition, expected: e.target.value })
            }
          />
        )}
      </div>
    </li>
  )
}

export interface ConditionEditorProps {
  conditions: WorkflowCondition[]
  onChange: (next: WorkflowCondition[]) => void
  t: TranslateFn
}

export default function ConditionEditor({
  conditions,
  onChange,
  t,
}: ConditionEditorProps) {
  const patchAt = (index: number, next: WorkflowCondition) => {
    const updated = conditions.slice()
    updated[index] = next
    // Keep only well-formed conditions; a half-filled row is dropped on change
    // but the current edit text must survive, so validate leniently here.
    onChange(updated)
  }

  const removeAt = (index: number) =>
    onChange(conditions.filter((_, i) => i !== index))

  const add = () =>
    onChange([...conditions, blankCondition('elementVisible')])

  return (
    <div className="flex flex-col gap-1.5">
      {conditions.length > 0 && (
        <ul className="m-0 flex flex-col gap-1.5 p-0" role="list">
          {conditions.map((condition, index) => (
            <ConditionRow
              key={index}
              condition={condition}
              t={t}
              onPatch={(next) => patchAt(index, next)}
              onRemove={() => removeAt(index)}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-ink"
        onClick={add}
      >
        <Plus size={13} />
        {t('nodeConditionAdd')}
      </button>
    </div>
  )
}
