/**
 * EditTabUrl — React port of Automa's EditTabURL.vue (block: tab-url).
 *
 * Selects which tab the URL is read from: the active tab or all tabs (with an
 * optional match-patterns / tab-title query), followed by the output
 * "assign to variable" controls (InsertWorkflowData).
 *
 * @module workflow-editor/blocks/batchB/EditTabUrl
 */

import type { EditFormProps } from '../EditForms'
import SaveOutputs from './SaveOutputs'
import { Field, Select, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'

const TYPES = [
  { value: 'active-tab', label: 'Active tab' },
  { value: 'all', label: 'All tabs' },
]

export default function EditTabUrl({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'active-tab'

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Select tab">
        <Select value={type} onChange={(v) => onChange({ type: v })} options={TYPES} />
      </Field>

      {type === 'all' && (
        <div style={{ border: '1px solid var(--bc-border)', borderRadius: 8, padding: 8, marginBottom: 12 }}>
          <p className="wf-form-note">Query</p>
          <Field label="Match Patterns (optional)">
            <TextInput
              value={str(data, 'qMatchPatterns')}
              placeholder="https://example.com/*"
              onChange={(v) => onChange({ qMatchPatterns: v })}
            />
          </Field>
          <Field label="Tab title (optional)">
            <TextInput value={str(data, 'qTitle')} onChange={(v) => onChange({ qTitle: v })} />
          </Field>
        </div>
      )}

      <SaveOutputs data={data} onChange={onChange} />
    </div>
  )
}
