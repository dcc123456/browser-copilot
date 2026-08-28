/**
 * EditNotification — React port of Automa's EditNotification.vue.
 *
 * Displays a desktop notification with a title, message, and optional icon /
 * image URLs. Permission gating (the Vue form hides the fields until the
 * "notifications" permission is granted) is handled by the extension runtime,
 * so this form always renders the fields.
 *
 * @module workflow-editor/blocks/batchD/EditNotification
 */

import type { EditFormProps } from '../EditForms'
import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'

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
        <TextInput value={str(data, 'title')} placeholder="Hello world!" onChange={(v) => onChange({ title: v })} />
      </Field>
      <Field label="Message">
        <TextArea value={str(data, 'message')} placeholder="Notification message" onChange={(v) => onChange({ message: v })} />
      </Field>
      <Field label="Icon URL (optional)">
        <TextInput value={str(data, 'iconUrl')} placeholder="https://example.com/icon.png" onChange={(v) => onChange({ iconUrl: v })} />
      </Field>
      <Field label="Image URL (optional)">
        <TextInput value={str(data, 'imageUrl')} placeholder="https://example.com/image.png" onChange={(v) => onChange({ imageUrl: v })} />
      </Field>
    </div>
  )
}
