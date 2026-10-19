/**
 * EditReloadTab — reload active tab block.
 *
 * Two modes behind one node: no URL reloads the tab where it is (Automa's
 * original behaviour), a URL replaces the tab's address and loads that instead.
 * The field is optional on purpose, so an existing node keeps reloading.
 *
 * @module workflow-editor/blocks/batchB/EditReloadTab
 */

import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'
import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'

export default function EditReloadTab({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="URL (optional)">
        <TextInput
          value={str(data, 'url')}
          placeholder="https://example.com/page"
          onChange={(v) => onChange({ url: v })}
        />
      </Field>

      <p className="wf-form-note">
        {bt(
          'Leave the URL empty to reload the page as it is; fill it in to load that URL in the current tab instead.',
        )}
      </p>
    </div>
  )
}
