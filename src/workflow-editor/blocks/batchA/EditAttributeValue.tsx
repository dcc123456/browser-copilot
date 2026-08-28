/**
 * EditAttributeValue — "Attribute value" block form.
 *
 * React port of Automa's EditAttributeValue.vue. Beyond the interaction
 * skeleton:
 *   - Action: get / set
 *   - Attribute name input
 *   - for `set`: the attribute value input
 *   - for `get`: the assign-to-variable / insert-to-table / add-extra-row
 *     groups (InsertWorkflowData)
 *
 * @module workflow-editor/blocks/batchA/EditAttributeValue
 */
import { Field, Select, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { str } from '../shared/InteractionBase'
import { InsertDataFields } from './_shared'

export default function EditAttributeValue({ data, onChange }: EditFormProps) {
  const action = str(data, 'action') || 'get'

  return (
    <InteractionBase data={data} onChange={onChange}>
      <hr />

      <Field label="Action">
        <Select
          value={action}
          onChange={(v) => onChange({ action: v })}
          options={[
            { value: 'get', label: 'Get attribute value' },
            { value: 'set', label: 'Set attribute value' },
          ]}
        />
      </Field>

      <Field label="Attribute name">
        <TextInput
          value={str(data, 'attributeName')}
          placeholder="name"
          onChange={(v) => onChange({ attributeName: v })}
        />
      </Field>

      {action === 'set' ? (
        <Field label="Attribute value">
          <TextInput
            value={str(data, 'attributeValue')}
            placeholder="value"
            onChange={(v) => onChange({ attributeValue: v })}
          />
        </Field>
      ) : (
        <InsertDataFields data={data} onChange={onChange} variables table extraRow />
      )}
    </InteractionBase>
  )
}
