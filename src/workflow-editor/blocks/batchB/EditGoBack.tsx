/**
 * EditGoBack — browser history "go back" block.
 *
 * Automa has no dedicated form for go-back (the catalog entry sets
 * `disableEdit: true`); this component renders an info notice plus the
 * standard no-settings note expected by the batch B registry.
 *
 * @module workflow-editor/blocks/batchB/EditGoBack
 */

import type { EditFormProps } from '../EditForms'

export default function EditGoBack(_props: EditFormProps) {
  return (
    <div className="wf-form">
      <p className="wf-form-note">This block navigates browser history (go back one page).</p>
      <p className="wf-form-note">No settings for this block.</p>
    </div>
  )
}
