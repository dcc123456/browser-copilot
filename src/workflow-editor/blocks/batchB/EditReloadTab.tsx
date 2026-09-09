/**
 * EditReloadTab — reload active tab block.
 *
 * Automa has no dedicated form for reload-tab (the catalog entry sets
 * `disableEdit: true`); this component renders the standard no-settings
 * notice expected by the batch B registry.
 *
 * @module workflow-editor/blocks/batchB/EditReloadTab
 */

import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'

export default function EditReloadTab(_props: EditFormProps) {
  const { bt } = useEditorLocale()
  return (
    <div className="wf-form">
      <p className="wf-form-note">{bt('This block reloads the active tab.')}</p>
      <p className="wf-form-note">{bt('No settings for this block.')}</p>
    </div>
  )
}
