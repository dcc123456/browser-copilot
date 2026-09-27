/**
 * EditUploadFile — "Upload file" block form.
 *
 * Two source modes share one node (spec §4, §14):
 *
 *   - `user-select`: the user picks local files at run time from a Browser
 *     Copilot "Choose file" card (real user gesture); the Workflow then
 *     injects them automatically.
 *   - `workflow-file`: files already in a Workflow variable (screenshot,
 *     JavaScript-generated image, file artifact or array) are injected
 *     without opening the OS chooser.
 *
 * The selector field, multiple flag and wait-for-selector options are shared.
 * Styled with Tailwind semantic tokens; form labels pass through `bt()`.
 *
 * @module workflow-editor/blocks/batchA/EditUploadFile
 */
import { useEditorLocale } from '../../locale-context'
import { Checkbox, Field, TextInput } from '../shared/Field'
import SelectorField from '../shared/SelectorField'
import type { EditFormProps } from '../EditForms'

export default function EditUploadFile({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const sourceMode = data.sourceMode === 'workflow-file' ? 'workflow-file' : 'user-select'
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
        <div className="flex flex-col gap-1.5">
          {(
            [
              ['user-select', 'User picks files'],
              ['workflow-file', 'Workflow file variable'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 text-sm text-ink"
            >
              <input
                type="radio"
                name="upload-source-mode"
                value={value}
                checked={sourceMode === value}
                onChange={() => onChange({ sourceMode: value })}
                className="accent-accent"
              />
              <span>{bt(label)}</span>
            </label>
          ))}
        </div>
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
      ) : (
        <Field
          label="File variable"
          title="Variable holding a data URL, a file artifact, or an array of artifacts"
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
      )}

      <SelectorField
        data={data}
        selector={selector}
        onSelector={(v) => onChange({ selector: v })}
        findBy={data.findBy === 'xpath' ? 'xpath' : 'cssSelector'}
        onFindBy={(v) => onChange({ findBy: v })}
        multiple={false}
      />

      <Checkbox
        checked={data.multiple === true}
        onChange={(v) => onChange({ multiple: v })}
        label="Allow multiple files"
        title="Upload several files at once (the page input must accept multiple)"
      />

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
