/**
 * EditGetText — "Get text" block form.
 *
 * React port of Automa's EditGetText.vue. Beyond the interaction skeleton:
 *   - a regex filter row with an expression-flags popover (g / i / m)
 *   - prefix / suffix text inputs
 *   - "Include HTML tags" and "Use textContent" checkboxes
 *   - the assign-to-variable / insert-to-table / add-extra-row groups
 *     (InsertWorkflowData)
 *
 * @module workflow-editor/blocks/batchA/EditGetText
 */
import { Checkbox, Field, TextInput } from '../shared/Field'
import PopupField from '../shared/PopupField'
import { useEditorLocale } from '../../locale-context'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, str } from '../shared/InteractionBase'
import { InsertDataFields } from './_shared'

const REGEX_FLAGS = [
  { id: 'g', name: 'global' },
  { id: 'i', name: 'ignore case' },
  { id: 'm', name: 'multiline' },
]

function readRegexExp(data: Record<string, unknown>): string[] {
  const raw = data.regexExp
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (raw && typeof raw === 'object')
    return Object.values(raw).filter((x): x is string => typeof x === 'string')
  return []
}

export default function EditGetText({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const regexExp = readRegexExp(data)

  const toggleFlag = (id: string, on: boolean) => {
    const next = on ? [...regexExp, id] : regexExp.filter((f) => f !== id)
    onChange({ regexExp: [...new Set(next)] })
  }

  return (
    <InteractionBase data={data} onChange={onChange}>
      <hr />

      <Field label="Regex">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>/</span>
          <TextInput
            value={str(data, 'regex')}
            placeholder="Regex"
            onChange={(v) => onChange({ regex: v })}
          />
          <span className="shrink-0 text-xs text-muted">/{regexExp.join('') || bt('None')}</span>
        </div>
      </Field>
      <PopupField
        title="Expression flags"
        summary={regexExp.length ? regexExp.join('') : bt('None')}
        editLabel="Expression flags"
        icon="lucide:ScanText"
        size="sm"
      >
        {REGEX_FLAGS.map((item) => (
          <Checkbox
            key={item.id}
            checked={regexExp.includes(item.id)}
            onChange={(v) => toggleFlag(item.id, v)}
            label={item.name}
          />
        ))}
      </PopupField>

      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Text prefix">
          <TextInput
            value={str(data, 'prefixText')}
            placeholder="Text"
            onChange={(v) => onChange({ prefixText: v })}
          />
        </Field>
        <Field label="Text suffix">
          <TextInput
            value={str(data, 'suffixText')}
            placeholder="Text"
            onChange={(v) => onChange({ suffixText: v })}
          />
        </Field>
      </div>

      <Checkbox
        checked={bool(data, 'includeTags')}
        onChange={(v) => onChange({ includeTags: v })}
        label="Include HTML tags"
      />
      <Checkbox
        checked={bool(data, 'useTextContent')}
        onChange={(v) => onChange({ useTextContent: v })}
        label={
          <>
            Use <code>textContent</code>
          </>
        }
      />

      <hr />

      <InsertDataFields data={data} onChange={onChange} variables table extraRow />
    </InteractionBase>
  )
}
