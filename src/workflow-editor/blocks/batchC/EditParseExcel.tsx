/**
 * EditParseExcel — edit form for the local `parse-excel` block.
 *
 * One spreadsheet comes from either the runtime picker (`user-select`) or an
 * upstream file artifact (`workflow-file`). The parser writes two variables:
 * object rows keyed by the first row, and the raw 2-D array that keeps it.
 * `.xls` is rejected with a conversion hint by the executor, not the form.
 *
 * @module workflow-editor/blocks/batchC/EditParseExcel
 */
import { useEditorLocale } from '../../locale-context'
import { Checkbox, Field, Select, TextInput } from '../shared/Field'
import DownloadFilePicker from '../shared/DownloadFilePicker'
import type { EditFormProps } from '../EditForms'

const SUGGESTED_VARIABLES = ['lastFile', 'fileArtifact', 'lastScreenshot', 'generatedImage']

export default function EditParseExcel({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const sourceMode =
    data.sourceMode === 'workflow-file'
      ? 'workflow-file'
      : data.sourceMode === 'file-path'
        ? 'file-path'
        : 'user-select'

  return (
    <div className="wf-form flex flex-col gap-3">
      <Field label="Spreadsheet source">
        <Select
          value={sourceMode}
          onChange={(v) => onChange({ sourceMode: v })}
          options={[
            { value: 'user-select', label: 'User picks a file' },
            { value: 'workflow-file', label: 'Workflow file variable' },
            { value: 'file-path', label: 'Specific file path' },
          ]}
        />
      </Field>

      {sourceMode === 'file-path' && (
        <DownloadFilePicker
          value={typeof data.filePath === 'string' ? data.filePath : ''}
          onChange={(v) => onChange({ filePath: v })}
          accept=".xlsx,.csv"
        />
      )}

      {sourceMode === 'workflow-file' && (
        <Field
          label="File variable"
          title="Variable holding exactly one spreadsheet file artifact or data URL"
        >
          <TextInput
            value={typeof data.fileVariable === 'string' ? data.fileVariable : ''}
            placeholder="e.g. lastFile"
            list="parse-excel-variables"
            onChange={(v) => onChange({ fileVariable: v })}
          />
          <datalist id="parse-excel-variables">
            {SUGGESTED_VARIABLES.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
      )}

      <Field
        label="Worksheet name"
        title="Exact worksheet name; empty = the first sheet. Applies to .xlsx only."
      >
        <TextInput
          value={typeof data.sheetName === 'string' ? data.sheetName : ''}
          placeholder="Sheet1 (optional)"
          onChange={(v) => onChange({ sheetName: v })}
        />
      </Field>

      <Checkbox
        checked={data.hasHeader !== false}
        onChange={(v) => onChange({ hasHeader: v })}
        label="First row is the header"
        title="Use the first row as object keys; the raw array keeps that row either way"
      />

      <Field
        label="Object rows variable"
        title="Receives an array of objects, one per data row, keyed by the header row"
      >
        <TextInput
          value={typeof data.variableName === 'string' ? data.variableName : ''}
          placeholder="lastExcelRows"
          onChange={(v) => onChange({ variableName: v })}
          fallback="lastExcelRows"
          noSlash
        />
      </Field>

      <Field
        label="Raw rows variable"
        title="Receives the 2-D array of typed cells, including the header row"
      >
        <TextInput
          value={typeof data.rawVariableName === 'string' ? data.rawVariableName : ''}
          placeholder="lastExcelRawRows"
          onChange={(v) => onChange({ rawVariableName: v })}
          fallback="lastExcelRawRows"
          noSlash
        />
      </Field>

      <p className="text-xs text-muted">
        {bt('Supports .xlsx and .csv. Legacy .xls must be saved as .xlsx or .csv first.')}
      </p>
    </div>
  )
}
