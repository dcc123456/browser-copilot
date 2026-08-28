/**
 * EditForwardPage — browser history "go forward" block.
 *
 * Automa has no dedicated form for forward-page (the catalog entry sets
 * `disableEdit: true`); this component renders an info notice plus the
 * standard no-settings note expected by the batch B registry.
 *
 * @module workflow-editor/blocks/batchB/EditForwardPage
 */

import type { EditFormProps } from '../EditForms'

export default function EditForwardPage(_props: EditFormProps) {
  return (
    <div className="wf-form">
      <p className="wf-form-note">This block navigates browser history (go forward one page).</p>
      <p className="wf-form-note">No settings for this block.</p>
    </div>
  )
}
