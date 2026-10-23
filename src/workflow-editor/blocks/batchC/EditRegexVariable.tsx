/**
 * EditRegexVariable — React port of Automa's EditRegexVariable.vue.
 *
 * Matches a variable value against a regular expression (method `match`) or
 * replaces matches (`replace`, with replaceVal). The expression is stored
 * without delimiters; flags are a multi-select list stored on `data.flag`
 * (string[]). Fields: variableName, method, replaceVal, expression, flag.
 *
 * @module workflow-editor/blocks/batchC/EditRegexVariable
 */

import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import PopupField from '../shared/PopupField'
import { str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import type { EditFormProps } from '../EditForms'

const METHODS = [
  { value: 'match', label: 'Match value' },
  { value: 'replace', label: 'Replace value' },
]

const FLAGS = [
  { id: 'g', name: 'global' },
  { id: 'i', name: 'ignore case' },
  { id: 'm', name: 'multiline' },
]

export default function EditRegexVariable({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const flags = Array.isArray(data.flag)
    ? (data.flag as unknown[]).filter((f): f is string => typeof f === 'string')
    : []

  const toggleFlag = (flag: string, include: boolean) => {
    const next = include ? [...flags, flag] : flags.filter((f) => f !== flag)
    onChange({ flag: next })
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

      <Field label="Variable name" title="Variable name">
        <TextInput
          value={str(data, 'variableName')}
          placeholder="abc123"
          onChange={(v) => onChange({ variableName: v })}
          noSlash
        />
      </Field>

      <Field label="Method">
        <Select
          value={str(data, 'method') || 'match'}
          onChange={(v) => onChange({ method: v })}
          options={METHODS}
        />
      </Field>

      {str(data, 'method') === 'replace' && (
        <Field label="Replace with">
          <TextInput
            value={str(data, 'replaceVal')}
            placeholder="(empty)"
            onChange={(v) => onChange({ replaceVal: v })}
          />
        </Field>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label="RegEx">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'var(--bc-input-bg, #f1f1f1)',
                borderRadius: 8,
                padding: '0 12px',
              }}
            >
              <span>/</span>
              <input
                type="text"
                value={str(data, 'expression')}
                placeholder="Expression"
                onChange={(e) => onChange({ expression: e.target.value })}
                style={{ flex: 1, background: 'transparent', border: 'none' }}
              />
              <span>/</span>
              <span className="shrink-0 text-xs text-muted">{flags.join('')}</span>
            </div>
          </Field>
        </div>
      </div>

      <PopupField
        title="Expression flags"
        summary={flags.length ? flags.join('') : bt('None')}
        editLabel="Expression flags"
        icon="lucide:ScanText"
        size="sm"
      >
        {FLAGS.map((flag) => (
          <Checkbox
            key={flag.id}
            checked={flags.includes(flag.id)}
            onChange={(v) => toggleFlag(flag.id, v)}
            label={flag.name}
          />
        ))}
      </PopupField>
    </div>
  )
}
