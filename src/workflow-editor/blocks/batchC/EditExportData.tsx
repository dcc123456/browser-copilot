/**
 * EditExportData — React port of Automa's EditExportData.vue.
 *
 * Exports the table (data columns), a Google Sheet ref, or a variable to a
 * downloaded file (JSON / CSV / plain text). The downloads-permission prompt
 * and variable autocomplete are out of scope; Google Sheets stays in the
 * dropdown for data parity but needs a reference key.
 *
 * @module workflow-editor/blocks/batchC/EditExportData
 */

import { Checkbox, Expand, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

const DATA_TO_EXPORT = [
  { value: 'data-columns', label: 'Table' },
  { value: 'google-sheets', label: 'Google Sheets' },
  { value: 'variable', label: 'Variable' },
]

const ON_CONFLICT = [
  { value: 'uniquify', label: 'Uniquify' },
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'prompt', label: 'Prompt' },
]

const EXPORT_TYPES = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'plain-text', label: 'Plain text' },
]

export default function EditExportData({ data, onChange }: EditFormProps) {
  const dataToExport = str(data, 'dataToExport') || 'data-columns'
  const type = str(data, 'type') || 'json'

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Data to export">
        <Select value={dataToExport} onChange={(v) => onChange({ dataToExport: v })} options={DATA_TO_EXPORT} />
      </Field>

      {dataToExport === 'google-sheets' && (
        <Field label="Reference key" title="Reference key">
          <TextInput value={str(data, 'refKey')} placeholder="Reference key" onChange={(v) => onChange({ refKey: v })} />
        </Field>
      )}

      {dataToExport === 'variable' && (
        <Field label="Variable name" title="Variable name">
          <TextInput value={str(data, 'variableName')} placeholder="abc123" onChange={(v) => onChange({ variableName: v })} />
        </Field>
      )}

      <Field label="File name">
        <TextInput value={str(data, 'name')} placeholder="unnamed" onChange={(v) => onChange({ name: v })} />
      </Field>

      <Field label="On conflict">
        <Select value={str(data, 'onConflict') || 'uniquify'} onChange={(v) => onChange({ onConflict: v })} options={ON_CONFLICT} />
      </Field>

      <Field label="Export as">
        <Select value={type} onChange={(v) => onChange({ type: v })} options={EXPORT_TYPES} />
      </Field>

      {type === 'csv' && (
        <Expand title="Options" defaultOpen>
          <Checkbox checked={bool(data, 'addBOMHeader')} onChange={(v) => onChange({ addBOMHeader: v })} label="Add UTF-8 BOM" />
          <Field label="Delimiter">
            <TextInput value={str(data, 'csvDelimiter')} placeholder="," fallback="," onChange={(v) => onChange({ csvDelimiter: v })} />
          </Field>
        </Expand>
      )}
    </div>
  )
}
