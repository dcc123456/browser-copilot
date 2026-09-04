/**
 * EditSetVariable — edit form for the local `set-variable` block.
 *
 * The block stores a value (supports `{{variables}}` interpolation) into a
 * named workflow variable for later blocks to read. Conversation-generated
 * OCR flows use it to carry the recognized image URL into the `ocr` block
 * (see `lib/storage.ts` `OCR_IMAGE_VARIABLE`).
 *
 * @module workflow-editor/blocks/batchC/EditSetVariable
 */

import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditSetVariable({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Variable name">
        <TextInput
          value={str(data, 'variableName')}
          placeholder="Variable the value is stored under"
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>

      <Field label="Value" title="Supports {{variables}}">
        <TextArea
          value={str(data, 'value')}
          placeholder="Value to store — supports {{variables}}"
          onChange={(v) => onChange({ value: v })}
        />
      </Field>
    </div>
  )
}
