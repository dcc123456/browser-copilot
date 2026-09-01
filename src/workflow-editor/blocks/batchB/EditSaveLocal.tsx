/**
 * EditSaveLocal — 「保存到本地」block 表单。
 *
 * 输入可插值的内容 value 与含扩展名的文件名，并选择保存策略：跟随全局自动保存
 * 设置（auto）、强制自动保存到下载目录（force）、或每次询问保存位置（manual）。
 *
 * @module workflow-editor/blocks/batchB/EditSaveLocal
 */

import type { EditFormProps } from '../EditForms'
import { Field, Select, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'

const SAVE_MODES = [
  { value: 'auto', label: 'Auto (follow global setting)' },
  { value: 'force', label: 'Force auto-save to download folder' },
  { value: 'manual', label: 'Ask where to save each time' },
]

export default function EditSaveLocal({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Content">
        <TextInput
          value={str(data, 'value')}
          placeholder="Text or {{variable}}"
          onChange={(v) => onChange({ value: v })}
        />
      </Field>

      <Field label="Filename (with extension)">
        <TextInput
          value={str(data, 'filename')}
          placeholder="report.md"
          onChange={(v) => onChange({ filename: v })}
        />
      </Field>

      <Field label="Save mode">
        <Select
          value={str(data, 'saveMode') || 'auto'}
          onChange={(v) => onChange({ saveMode: v })}
          options={SAVE_MODES}
        />
      </Field>

      <Field label="Variable name (output path)">
        <TextInput
          value={str(data, 'variableName') || 'lastSavedPath'}
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>
    </div>
  )
}