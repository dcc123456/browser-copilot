/**
 * EditForms — "Forms" block form (manipulate text-field / select / checkbox /
 * radio elements).
 *
 * React port of Automa's EditForms.vue. The interaction skeleton handles the
 * selector; the trailing fields handle:
 *   - "Get form value" mode: assign the element's value to a variable
 *   - otherwise: choose the form type (text-field / select / checkbox / radio)
 *     and per-type options (typed value + clear flag, option selection by
 *     value/position, selected checkbox/radio flag, typing delay).
 *
 * Automa's select uses an `<optgroup>` to group the option-position choices;
 * the shared Select only supports flat option lists, so the grouping label is
 * folded into the option labels ("Position: …").
 *
 * @module workflow-editor/blocks/batchA/EditForms
 */
import { Checkbox, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, str, num } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import { AssignVariableFields } from './_shared'

const FORM_TYPES = [
  { value: 'text-field', label: 'Text field' },
  { value: 'select', label: 'Select' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio' },
]

/** What the "Value" box holds, per form type — multilingual via the block dictionary. */
const VALUE_HINT_TEXT_FIELD =
  'Content to fill into the field. Supports variable references such as {{lastOcrText}} (the latest OCR result) or {{aiFill1}} (AI-generated content).'
const VALUE_HINT_SELECT = 'Option value to select. Supports variable references such as {{lastOcrText}}.'

export default function EditForms({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const getValue = bool(data, 'getValue')
  const type = str(data, 'type') || 'text-field'
  const selectOptionBy = str(data, 'selectOptionBy') || 'value'

  return (
    <InteractionBase data={data} onChange={onChange}>
      <hr />

      <Checkbox checked={getValue} onChange={(v) => onChange({ getValue: v })} label="Get form value" />

      {getValue ? (
        <AssignVariableFields data={data} onChange={onChange} />
      ) : (
        <>
          <div style={{ marginTop: 16 }}>
            <Field label="Form type">
              <Select value={type} onChange={(v) => onChange({ type: v })} options={FORM_TYPES} />
            </Field>
          </div>

          {(type === 'checkbox' || type === 'radio') && (
            <Checkbox
              checked={bool(data, 'selected')}
              onChange={(v) => onChange({ selected: v })}
              label="Selected"
            />
          )}

          {type === 'text-field' && (
            <>
              <Field label="Value">
                <TextArea
                  value={str(data, 'value')}
                  placeholder="Value"
                  onChange={(v) => onChange({ value: v })}
                />
              </Field>
              <p className="wf-hint">{bt(VALUE_HINT_TEXT_FIELD)}</p>
              <Checkbox
                checked={bool(data, 'clearValue')}
                onChange={(v) => onChange({ clearValue: v })}
                label="Clear form value"
              />
            </>
          )}

          {type === 'select' && (
            <>
              <Field label="Select an option by">
                <Select
                  value={selectOptionBy}
                  onChange={(v) => onChange({ selectOptionBy: v })}
                  options={[
                    { value: 'value', label: 'The value' },
                    { value: 'first-option', label: 'Position: First option' },
                    { value: 'last-option', label: 'Position: Last option' },
                    { value: 'custom-position', label: 'Position: Custom' },
                  ]}
                />
              </Field>
              {selectOptionBy === 'value' && (
                <>
                  <Field label="Value">
                    <TextArea
                      value={str(data, 'value')}
                      placeholder="Value"
                      onChange={(v) => onChange({ value: v })}
                    />
                  </Field>
                  <p className="wf-hint">{bt(VALUE_HINT_SELECT)}</p>
                  <Checkbox
                    checked={bool(data, 'clearValue')}
                    onChange={(v) => onChange({ clearValue: v })}
                    label="Clear form value"
                  />
                </>
              )}
              {selectOptionBy === 'custom-position' && (
                <Field label="Option position">
                  <TextInput
                    type="number"
                    value={str(data, 'optionPosition')}
                    placeholder="0"
                    fallback="1"
                    onChange={(v) => onChange({ optionPosition: v })}
                  />
                </Field>
              )}
            </>
          )}

          {type === 'text-field' && (
            <Field label="Typing delay (millisecond)(0 to disable)">
              <NumberInput
                value={num(data, 'delay', 0)}
                placeholder="Delay"
                fallback={0}
                onChange={(n) => onChange({ delay: n })}
              />
            </Field>
          )}
        </>
      )}
    </InteractionBase>
  )
}
