/**
 * EditClipboard — React port of Automa's EditClipboard.vue (block: clipboard).
 *
 * Get clipboard data (with assign-to-variable output controls) or insert text
 * to the clipboard (a text box, or a "copy the selected text on page"
 * checkbox). Automa gates the form behind a clipboard-permission check; the
 * editor always renders the form.
 *
 * @module workflow-editor/blocks/batchB/EditClipboard
 */

import type { EditFormProps } from '../EditForms'
import SaveOutputs from './SaveOutputs'
import { Checkbox, Field, Select, TextArea } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

const TYPES = [
  { value: 'get', label: 'Get clipboard data' },
  { value: 'insert', label: 'Insert text to clipboard' },
]

export default function EditClipboard({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'get'
  const copySelectedText = bool(data, 'copySelectedText')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field>
        <Select value={type} onChange={(v) => onChange({ type: v })} options={TYPES} />
      </Field>

      {type === 'get' ? (
        <SaveOutputs data={data} onChange={onChange} />
      ) : (
        <>
          {!copySelectedText && (
            <Field label="Text">
              <TextArea
                value={str(data, 'dataToCopy')}
                placeholder="Text"
                onChange={(v) => onChange({ dataToCopy: v })}
              />
            </Field>
          )}
          <Checkbox
            checked={copySelectedText}
            onChange={(v) => onChange({ copySelectedText: v })}
            label="Copy the selected text on page"
          />
        </>
      )}
    </div>
  )
}
