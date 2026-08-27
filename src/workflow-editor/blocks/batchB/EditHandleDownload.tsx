/**
 * EditHandleDownload — React port of Automa's EditHandleDownload.vue
 * (block: handle-download).
 *
 * Timeout, optional download ID, file name and on-conflict policy (hidden when
 * a download ID is given), a "wait for the file to be downloaded" toggle and
 * the assign-to-variable output controls (InsertWorkflowData). Automa gates
 * the form behind a downloads-permission check; the editor always renders it.
 *
 * @module workflow-editor/blocks/batchB/EditHandleDownload
 */

import type { EditFormProps } from '../EditForms'
import SaveOutputs from './SaveOutputs'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const ON_CONFLICT = [
  { value: 'uniquify', label: 'Uniquify' },
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'prompt', label: 'Prompt' },
]

export default function EditHandleDownload({ data, onChange }: EditFormProps) {
  const downloadId = str(data, 'downloadId')
  const waitForDownload = bool(data, 'waitForDownload')
  const hasDownloadId = downloadId.trim().length > 0

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Timeout (milliseconds)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 20000)}
          placeholder="1000"
          onChange={(v) => onChange({ timeout: Number(v) || 1000 })}
        />
      </Field>

      <Field label="File download ID (optional)">
        <TextInput value={downloadId} placeholder="0" onChange={(v) => onChange({ downloadId: v })} />
      </Field>

      {!hasDownloadId && (
        <>
          <Field label="File name (optional)">
            <TextInput
              value={str(data, 'filename')}
              placeholder="file"
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
        </>
      )}

      <Checkbox
        checked={waitForDownload}
        onChange={(v) => onChange({ waitForDownload: v })}
        label="Wait for the file to be downloaded"
      />

      {waitForDownload && (
        <>
          <p className="wf-form-note">File path</p>
          <SaveOutputs data={data} onChange={onChange} />
        </>
      )}
    </div>
  )
}
