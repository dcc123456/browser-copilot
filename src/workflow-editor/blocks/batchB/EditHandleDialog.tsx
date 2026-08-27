/**
 * EditHandleDialog — React port of Automa's EditHandleDialog.vue
 * (block: handle-dialog).
 *
 * Accept or dismiss a JavaScript dialog (alert/confirm/prompt/onbeforeunload);
 * when accepting, an optional prompt text is entered first.
 *
 * @module workflow-editor/blocks/batchB/EditHandleDialog
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

export default function EditHandleDialog({ data, onChange }: EditFormProps) {
  const accept = bool(data, 'accept')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Checkbox checked={accept} onChange={(v) => onChange({ accept: v })} label="Accept dialog" />

      {accept && (
        <Field label="Prompt text (optional)">
          <TextInput
            value={str(data, 'promptText')}
            placeholder="Text"
            onChange={(v) => onChange({ promptText: v })}
          />
        </Field>
      )}
    </div>
  )
}
