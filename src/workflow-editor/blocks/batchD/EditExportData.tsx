/**
 * EditExportData — React port of Automa's EditExportData.vue.
 *
 * Exports the workflow's table / a variable to a downloaded file (JSON, CSV or
 * plain text). The Google Sheets export option exists in Automa but is a cloud
 * block here, so it is omitted from the select.
 *
 * @module workflow-editor/blocks/batchD/EditExportData
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

export default function EditExportData({ data, onChange }: EditFormProps) {
  const dataToExport = str(data, 'dataToExport') || 'data-columns'
  const type = str(data, 'type') || 'json'
  const onConflict = str(data, 'onConflict') || 'uniquify'

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
        <Select
          value={dataToExport}
          onChange={(v) => onChange({ dataToExport: v })}
          options={[
            { value: 'data-columns', label: 'Table' },
            { value: 'variable', label: 'Variable' },
          ]}
        />
      </Field>

      {dataToExport === 'variable' && (
        <Field label="Variable name">
          <TextInput value={str(data, 'variableName')} placeholder="Variable name" onChange={(v) => onChange({ variableName: v })} />
        </Field>
      )}

      <Field label="File name">
        <TextInput value={str(data, 'name')} placeholder="unnamed" onChange={(v) => onChange({ name: v })} />
      </Field>

      <Field label="On conflict">
        <Select
          value={onConflict}
          onChange={(v) => onChange({ onConflict: v })}
          options={[
            { value: 'uniquify', label: 'Uniquify' },
            { value: 'overwrite', label: 'Overwrite' },
            { value: 'prompt', label: 'Prompt' },
          ]}
        />
      </Field>

      <Field label="Export as">
        <Select
          value={type}
          onChange={(v) => onChange({ type: v })}
          options={[
            { value: 'json', label: 'JSON' },
            { value: 'csv', label: 'CSV' },
            { value: 'plain-text', label: 'Plain text' },
          ]}
        />
      </Field>

      {type === 'csv' && (
        <Expand title="Options">
          <Checkbox
            checked={bool(data, 'addBOMHeader')}
            onChange={(v) => onChange({ addBOMHeader: v })}
            label="Add UTF-8 BOM"
          />
          <Field label="Delimiter">
            <TextInput value={str(data, 'csvDelimiter')} placeholder="," fallback="," onChange={(v) => onChange({ csvDelimiter: v })} />
          </Field>
        </Expand>
      )}
    </div>
  )
}
