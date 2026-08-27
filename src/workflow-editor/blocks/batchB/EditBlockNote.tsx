/**
 * EditBlockNote — note block form.
 *
 * Automa has no dedicated edit component for the note block (the catalog
 * entry sets `disableEdit: true`; notes are edited inline on the canvas).
 * This minimal form exposes the note's single `note` text field for the
 * React editor sidebar.
 *
 * @module workflow-editor/blocks/batchB/EditBlockNote
 */

import type { EditFormProps } from '../EditForms'
import { Field, TextArea } from '../shared/Field'
import { str } from '../shared/InteractionBase'

export default function EditBlockNote({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          rows={4}
          value={str(data, 'note')}
          placeholder="Write a note..."
          onChange={(v) => onChange({ note: v })}
        />
      </Field>
    </div>
  )
}
