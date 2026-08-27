/**
 * EditElementExists — "Element exists" condition block form.
 *
 * React port of Automa's EditElementExists.vue. Vue renders a custom layout
 * (description, find-by, selector input, try count, per-try timeout, and a
 * throw-error switch); per the porting rules this form is built on the shared
 * InteractionBase skeleton (description + find-by + selector pick/verify +
 * selector options, which also carries the element-mark option), and the
 * block-specific fields are rendered after it.
 *
 * Automa's Element-exists re-checks the selector `tryCount` times, waiting
 * `timeout` ms between tries; `throwError` makes a missing element fail the
 * block instead of taking the fallback branch.
 *
 * @module workflow-editor/blocks/batchA/EditElementExists
 */
import { Checkbox, Field, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, num } from '../shared/InteractionBase'

export default function EditElementExists({ data, onChange }: EditFormProps) {
  return (
    <InteractionBase data={data} onChange={onChange} hideMarkEl>
      <Field label="Try for">
        <TextInput
          type="number"
          value={num(data, 'tryCount', 1)}
          onChange={(v) => onChange({ tryCount: Number(v) || 1 })}
        />
      </Field>
      <Field label="Timeout (milliseconds)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 500)}
          onChange={(v) => onChange({ timeout: Number(v) || 500 })}
        />
      </Field>
      <Checkbox
        checked={bool(data, 'throwError')}
        onChange={(v) => onChange({ throwError: v })}
        label="Throw an error if doesn't exist"
      />
    </InteractionBase>
  )
}
