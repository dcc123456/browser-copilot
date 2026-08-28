/**
 * EditUploadFile — "Upload file" block form.
 *
 * React port of Automa's EditUploadFile.vue. The interaction skeleton handles
 * the `<input type="file">` selector; the trailing fields manage a list of
 * file paths / URLs / base64 values (`filePaths`), each with a remove action,
 * plus an "Add file" button.
 *
 * Note: Automa hides the list behind a `browser.extension.isAllowedFileSchemeAccess()`
 * / Firefox check and shows a warning instead; the React editor always shows
 * the path list (the requirement/permission messaging is surfaced by the
 * runtime instead).
 *
 * @module workflow-editor/blocks/batchA/EditUploadFile
 */
import { Field, IconButton, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase from '../shared/InteractionBase'

export default function EditUploadFile({ data, onChange }: EditFormProps) {
  const filePaths: string[] = Array.isArray(data.filePaths)
    ? (data.filePaths as unknown[]).map((p) => (typeof p === 'string' ? p : ''))
    : []

  const setPaths = (paths: string[]) => onChange({ filePaths: paths })

  return (
    <InteractionBase data={data} onChange={onChange}>
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filePaths.map((path, index) => (
          <Field key={index} label={index === 0 ? 'URL or File path' : undefined}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={path}
                  placeholder="URL/File path/base64"
                  onChange={(v) => setPaths(filePaths.map((p, i) => (i === index ? v : p)))}
                />
              </div>
              <IconButton
                icon="ri-delete-bin-7-line"
                title="Remove file"
                onClick={() => setPaths(filePaths.filter((_, i) => i !== index))}
              />
            </div>
          </Field>
        ))}
        <button
          type="button"
          className="wf-btn-accent"
          style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer' }}
          onClick={() => setPaths([...filePaths, ''])}
        >
          Add file
        </button>
      </div>
    </InteractionBase>
  )
}
