/**
 * EditDelay — React port of Automa's EditDelay.vue (block: delay).
 *
 * A single delay time in milliseconds (500 by default). The runtime accepts
 * expressions such as `{{ variable }}`, so the value is kept as free text
 * even though it is stored numerically by default.
 *
 * @module workflow-editor/blocks/batchB/EditDelay
 */

import type { EditFormProps } from '../EditForms'
import { Field, TextInput } from '../shared/Field'

export default function EditDelay({ data, onChange }: EditFormProps) {
  const time = data.time
  const value = typeof time === 'string' || typeof time === 'number' ? time : 500

  return (
    <div className="wf-form">
      <Field label="Delay time (millisecond)">
        <TextInput
          value={value}
          onChange={(v) => onChange({ time: v })}
        />
      </Field>
    </div>
  )
}
