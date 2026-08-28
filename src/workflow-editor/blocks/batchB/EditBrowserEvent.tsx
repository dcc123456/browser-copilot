/**
 * Browser event block form — React port of Automa's EditBrowserEvent
 * (waits until the selected browser event fires: tab/network/download).
 *
 * @module workflow-editor/blocks/batchB/EditBrowserEvent
 */

import type { EditFormProps } from '../EditForms'
import { Field, Select, TextInput, TextArea, Checkbox } from '../shared/Field'
import { str, bool, num } from '../shared/InteractionBase'

const EVENTS = [
  { value: 'tab:loaded', label: 'Tab: page loaded' },
  { value: 'tab:closed', label: 'Tab: closed' },
  { value: 'tab:updated', label: 'Tab: updated' },
  { value: 'tab:activated', label: 'Tab: activated' },
  { value: 'net:request', label: 'Network: request' },
  { value: 'net:completed', label: 'Network: request completed' },
  { value: 'net:error', label: 'Network: request error' },
  { value: 'download:created', label: 'Download: created' },
]

export default function EditBrowserEvent({ data, onChange }: EditFormProps) {
  const event = str(data, 'eventName') || 'tab:loaded'
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>
      <Field label="Event">
        <Select value={event} onChange={(v) => onChange({ eventName: v })} options={EVENTS} />
      </Field>
      <Field label="Timeout (ms)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 10000)}
          onChange={(v) => onChange({ timeout: Number(v) || 10000 })}
        />
      </Field>
      {event.startsWith('tab:') && (
        <Checkbox
          checked={bool(data, 'setAsActiveTab')}
          onChange={(v) => onChange({ setAsActiveTab: v })}
          label="Set as active tab"
        />
      )}
      {event === 'tab:loaded' && (
        <Field label="Wait for tab URL">
          <TextInput
            value={str(data, 'tabUrl')}
            placeholder="Match pattern, e.g. https://example.com/*"
            onChange={(v) => onChange({ tabUrl: v })}
          />
        </Field>
      )}
      {event === 'download:created' && (
        <Field label="Download filename query">
          <TextInput
            value={str(data, 'fileQuery')}
            placeholder="filename substring"
            onChange={(v) => onChange({ fileQuery: v })}
          />
        </Field>
      )}
    </div>
  )
}
