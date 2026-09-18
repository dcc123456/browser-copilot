/**
 * EditReadPage — form for the local `read-page` block.
 *
 * The recordable counterpart of the chat agent's `read_current_page` tool:
 * reads the active tab and writes the result to a variable, optionally
 * appending it into the data table so `export-data` has something to write.
 *
 * Not an Automa port — the block is a Browser Copilot extension, like `ocr`.
 * Reuses the batch-A "assign to variable" / "insert to table" groups so its
 * collection controls match every other reading block.
 *
 * @module workflow-editor/blocks/batchB/EditReadPage
 */

import type { EditFormProps } from '../EditForms'
import { Field, Select, TextArea, TextInput } from '../shared/Field'
import { TableFields, AssignVariableFields } from '../batchA/_shared'
import { str } from '../shared/InteractionBase'

const SOURCES = [
  { value: 'text', label: 'Visible text' },
  { value: 'selection', label: 'Selected text' },
  { value: 'html', label: 'HTML' },
]

export default function EditReadPage({ data, onChange }: EditFormProps) {
  const source = str(data, 'source') || 'text'
  // `selection` comes from the user's highlight, so scoping it to a selector
  // would contradict what it means.
  const scoped = source !== 'selection'

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Read">
        <Select value={source} onChange={(v) => onChange({ source: v })} options={SOURCES} />
      </Field>

      {scoped && (
        <Field label="Element (optional)">
          <TextInput
            value={str(data, 'selector')}
            placeholder="Empty = the whole page"
            onChange={(v) => onChange({ selector: v })}
          />
        </Field>
      )}

      <Field label="Max characters">
        <TextInput
          value={String(data.maxChars ?? 20000)}
          placeholder="20000"
          onChange={(v) => onChange({ maxChars: Number(v) || 0 })}
        />
      </Field>

      <hr />

      <AssignVariableFields data={data} onChange={onChange} />
      <TableFields data={data} onChange={onChange} />
    </div>
  )
}
