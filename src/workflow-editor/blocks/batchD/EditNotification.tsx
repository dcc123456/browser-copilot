/**
 * EditNotification — React port of Automa's EditNotification.vue.
 *
 * Displays a desktop notification with a title, message, optional icon / image
 * URLs, and a "Send to Feishu" switch. Permission gating (the Vue form hides the
 * fields until the "notifications" permission is granted) is handled by the
 * extension runtime, so this form always renders the fields.
 *
 * @module workflow-editor/blocks/batchD/EditNotification
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

export default function EditNotification({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>
      <Field label="Title">
        <TextInput
          value={str(data, 'title')}
          placeholder="Hello world!"
          onChange={(v) => onChange({ title: v })}
        />
      </Field>
      <Field label="Message">
        <TextArea
          value={str(data, 'message')}
          placeholder="Notification message"
          onChange={(v) => onChange({ message: v })}
        />
      </Field>
      {/* Uses the Feishu webhook from Settings; a delivery failure is logged as a
          warning and the step still counts as done (same rule as scheduled tasks). */}
      <Checkbox
        checked={bool(data, 'notifyFeishu')}
        label="Send to Feishu"
        onChange={(v) => onChange({ notifyFeishu: v })}
      />
      <Field label="Icon URL (optional)">
        <TextInput
          value={str(data, 'iconUrl')}
          placeholder="https://example.com/icon.png"
          onChange={(v) => onChange({ iconUrl: v })}
        />
      </Field>
      <Field label="Image URL (optional)">
        <TextInput
          value={str(data, 'imageUrl')}
          placeholder="https://example.com/image.png"
          onChange={(v) => onChange({ imageUrl: v })}
        />
      </Field>
    </div>
  )
}
