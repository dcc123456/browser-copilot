/**
 * EditUploadFile — "Upload file" block form.
 *
 * Three source modes share one node (spec §4, §14):
 *
 *   - `user-select`: the user picks local files at run time from a Browser
 *     Copilot "Choose file" card (real user gesture); the Workflow then
 *     injects them automatically.
 *   - `workflow-file`: files already in a Workflow variable (screenshot,
 *     JavaScript-generated image, file artifact or array) are injected
 *     without opening the OS chooser.
 *   - `latest-download`: at run time the newest file matching `accept` /
 *     `filePattern` is read from the configured download folder (or the
 *     extension's internal download folder), subfolders included, and injected
 *     unattended.
 *   - `file-path`: one concrete file inside those download folders, named by
 *     a relative path (`reports/sales.xlsx`). No host absolute paths.
 *
 * The selector field, wait-for-selector and verification options are shared.
 * Styled with Tailwind semantic tokens; form labels pass through `bt()`.
 *
 * @module workflow-editor/blocks/batchA/EditUploadFile
 */
import { useEditorLocale } from '../../locale-context'
import { Checkbox, Field, Select, TextInput } from '../shared/Field'
import DownloadFilePicker from '../shared/DownloadFilePicker'
import SelectorField from '../shared/SelectorField'
import type { EditFormProps } from '../EditForms'

export default function EditUploadFile({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const sourceMode =
    data.sourceMode === 'workflow-file'
      ? 'workflow-file'
      : data.sourceMode === 'latest-download'
        ? 'latest-download'
        : data.sourceMode === 'file-path'
          ? 'file-path'
          : 'user-select'
  const selector = typeof data.selector === 'string' ? data.selector : ''

  // Common file-producing variables suggested for the variable field
  // (screenshot / OCR / generated-image outputs and file variables).
  const SUGGESTED_VARIABLES = [
    'lastScreenshot',
    'generatedImage',
    'screenshotData',
    'fileArtifact',
    'lastFile',
  ]

  return (
    <div className="wf-form flex flex-col gap-3">
      <Field label="Upload source">
        <Select
          value={sourceMode}
          onChange={(v) => onChange({ sourceMode: v })}
          options={[
            { value: 'user-select', label: 'User picks files' },
            { value: 'workflow-file', label: 'File from an earlier step' },
            { value: 'latest-download', label: 'Latest download file' },
            { value: 'file-path', label: 'Specific file path' },
          ]}
        />
      </Field>

      {sourceMode === 'user-select' ? (
        <Field
          label="Accepted file types"
          title="Optional accept filter, e.g. image/png,application/pdf"
        >
          <TextInput
            value={typeof data.accept === 'string' ? data.accept : ''}
            placeholder="image/*,.pdf (optional)"
            onChange={(v) => onChange({ accept: v })}
          />
        </Field>
      ) : sourceMode === 'workflow-file' ? (
        <>
          <Field
            label="Variable holding the file"
            title="Name of the workflow variable that contains a data URL, a file artifact, or an array of artifacts"
          >
            <TextInput
              value={typeof data.fileVariable === 'string' ? data.fileVariable : ''}
              placeholder="e.g. lastScreenshot"
              list="upload-file-variables"
              onChange={(v) => onChange({ fileVariable: v })}
            />
            <datalist id="upload-file-variables">
              {SUGGESTED_VARIABLES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
          <p className="wf-form-note">
            {bt(
              'Reads a file that an earlier block produced and saved in a variable — for example a screenshot, a generated image, or an uploaded artifact. Enter the variable name, not the workflow JSON and not a local path.',
            )}
          </p>
        </>
      ) : sourceMode === 'file-path' ? (
        <>
          <Field
            label="Accepted file types"
            title="Optional filter for the file list; the picked file is uploaded as-is"
          >
            <TextInput
              value={typeof data.accept === 'string' ? data.accept : ''}
              placeholder=".xlsx,.pdf (optional)"
              onChange={(v) => onChange({ accept: v })}
            />
          </Field>
          <DownloadFilePicker
            value={typeof data.filePath === 'string' ? data.filePath : ''}
            onChange={(v) => onChange({ filePath: v })}
            accept={typeof data.accept === 'string' ? data.accept : ''}
          />
        </>
      ) : (
        <>
          <Field
            label="Accepted file types"
            title="Optional accept filter, e.g. .xlsx,image/png,application/pdf"
          >
            <TextInput
              value={typeof data.accept === 'string' ? data.accept : ''}
              placeholder=".xlsx,.pdf (optional)"
              onChange={(v) => onChange({ accept: v })}
            />
          </Field>
          <Field
            label="File name pattern"
            title="Glob matched against the downloaded file name, e.g. report-*.xlsx"
          >
            <TextInput
              value={typeof data.filePattern === 'string' ? data.filePattern : ''}
              placeholder="report-*.xlsx (optional)"
              onChange={(v) => onChange({ filePattern: v })}
            />
          </Field>
          <Checkbox
            checked={data.fallbackToPicker === true}
            onChange={(v) => onChange({ fallbackToPicker: v })}
            label="Ask me to pick a file when nothing matches"
            title="Open the normal Choose file card when no downloaded file matches the filters"
          />
          <p className="wf-form-note">
            {bt(
              'Searches the download folder and its subfolders; the newest matching file is uploaded.',
            )}
          </p>
        </>
      )}

      <SelectorField
        data={data}
        selector={selector}
        onSelector={(v) => onChange({ selector: v })}
        findBy={data.findBy === 'xpath' ? 'xpath' : 'cssSelector'}
        onFindBy={(v) => onChange({ findBy: v })}
        multiple={false}
      />

      {sourceMode !== 'latest-download' && sourceMode !== 'file-path' && (
        <Checkbox
          checked={data.multiple === true}
          onChange={(v) => onChange({ multiple: v })}
          label="Allow multiple files"
          title="Upload several files at once (the page input must accept multiple)"
        />
      )}

      <Checkbox
        checked={data.waitForSelector === true}
        onChange={(v) => onChange({ waitForSelector: v })}
        label="Wait for selector before uploading"
      />
      {data.waitForSelector === true && (
        <Field label="Selector timeout (ms)">
          <TextInput
            value={String(data.waitSelectorTimeout ?? 10000)}
            onChange={(v) => onChange({ waitSelectorTimeout: Number(v) || 0 })}
          />
        </Field>
      )}

      <Checkbox
        checked={data.verifyAfterUpload !== false}
        onChange={(v) => onChange({ verifyAfterUpload: v })}
        label="Verify files reached the upload control"
      />
    </div>
  )
}
