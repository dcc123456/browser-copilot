/**
 * EditTakeScreenshot — React port of Automa's EditTakeScreenshot.vue
 * (block: take-screenshot).
 *
 * Capture target (page / full page / element, with a CSS selector for
 * elements), a JPEG quality slider, save-to-computer (file name + format),
 * insert-to-table column, and assign-to-variable controls.
 *
 * @module workflow-editor/blocks/batchB/EditTakeScreenshot
 */

import type { EditFormProps } from '../EditForms'
import SaveOutputs from './SaveOutputs'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const TYPES = [
  { value: 'page', label: 'A page' },
  { value: 'fullpage', label: 'A full page' },
  { value: 'element', label: 'An element' },
]

const EXTS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
]

export default function EditTakeScreenshot({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'page'
  const ext = str(data, 'ext') || 'png'
  const saveToComputer = bool(data, 'saveToComputer')
  const saveToColumn = bool(data, 'saveToColumn')
  const quality = num(data, 'quality', 100)

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Take a screenshot of">
        <Select value={type} onChange={(v) => onChange({ type: v })} options={TYPES} />
      </Field>

      {type === 'element' && (
        <Field label="CSS Selector">
          <TextInput
            value={str(data, 'selector')}
            placeholder=".element"
            onChange={(v) => onChange({ selector: v })}
          />
        </Field>
      )}

      {ext === 'jpeg' && (
        <Field label={`Image quality (${quality}%)`}>
          <input
            type="range"
            min={0}
            max={100}
            value={quality}
            onChange={(e) => {
              let q = Number(e.target.value)
              if (q <= 0) q = 0
              if (q >= 100) q = 100
              onChange({ quality: q })
            }}
            style={{ width: '100%' }}
          />
        </Field>
      )}

      <Checkbox
        checked={saveToComputer}
        onChange={(v) => onChange({ saveToComputer: v })}
        label="Save screenshot to computer"
      />
      {saveToComputer && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <Field label="File name">
              <TextInput
                value={str(data, 'fileName')}
                placeholder="File name"
                onChange={(v) => onChange({ fileName: v })}
              />
            </Field>
          </div>
          <div style={{ width: 96, flexShrink: 0 }}>
            <Field label="Type">
              <Select value={ext} onChange={(v) => onChange({ ext: v })} options={EXTS} />
            </Field>
          </div>
        </div>
      )}

      <Checkbox
        checked={saveToColumn}
        onChange={(v) => onChange({ saveToColumn: v })}
        label="Insert screenshot to table"
      />
      {saveToColumn && (
        <Field label="Select column">
          <TextInput
            value={str(data, 'dataColumn')}
            placeholder="Select column"
            onChange={(v) => onChange({ dataColumn: v })}
          />
        </Field>
      )}

      <SaveOutputs data={data} onChange={onChange} />
    </div>
  )
}
