/**
 * EditSaveAssets — React port of Automa's EditSaveAssets.vue (block:
 * save-assets).
 *
 * Built on the shared InteractionBase skeleton (description + selector
 * machinery): the asset source is either a media element (selector based) or
 * a direct URL, followed by filename, on-conflict policy, a "save items'
 * download IDs" switch and the assign-to-variable output controls. Automa
 * gates the extra fields behind a downloads-permission check; the editor
 * always renders them.
 *
 * @module workflow-editor/blocks/batchB/EditSaveAssets
 */

import type { EditFormProps } from '../EditForms'
import InteractionBase from '../shared/InteractionBase'
import { Field, Select, Switch, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import SaveOutputs from './SaveOutputs'

const TYPES = [
  { value: 'element', label: 'Media element (image, audio, or video)' },
  { value: 'url', label: 'URL' },
]

const ON_CONFLICT = [
  { value: 'uniquify', label: 'Uniquify' },
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'prompt', label: 'Prompt' },
]

export default function EditSaveAssets({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'element'
  const saveDownloadIds = bool(data, 'saveDownloadIds')

  return (
    <InteractionBase
      data={data}
      onChange={onChange}
      hideSelector={type !== 'element'}
      header={
        <Field label="Type">
          <Select value={type} onChange={(v) => onChange({ type: v })} options={TYPES} />
        </Field>
      }
    >
      {type === 'url' && (
        <Field label="URL">
          <TextInput
            value={str(data, 'url')}
            placeholder="https://example.com/picture.png"
            onChange={(v) => onChange({ url: v })}
          />
        </Field>
      )}

      <Field label="Filename (optional)">
        <TextInput
          value={str(data, 'filename')}
          placeholder="image.jpeg"
          onChange={(v) => onChange({ filename: v })}
        />
      </Field>

      <Field label="On conflict">
        <Select
          value={str(data, 'onConflict') || 'uniquify'}
          onChange={(v) => onChange({ onConflict: v })}
          options={ON_CONFLICT}
        />
      </Field>

      <Switch
        checked={saveDownloadIds}
        onChange={(v) => onChange({ saveDownloadIds: v })}
        label="Save items' download IDs"
      />

      {saveDownloadIds && <SaveOutputs data={data} onChange={onChange} />}
    </InteractionBase>
  )
}
