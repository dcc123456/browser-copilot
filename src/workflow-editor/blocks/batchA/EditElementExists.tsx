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
import { Checkbox, Field, NumberInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, num } from '../shared/InteractionBase'

export default function EditElementExists({ data, onChange }: EditFormProps) {
  return (
    <InteractionBase data={data} onChange={onChange} hideMarkEl>
      <Field label="Try for">
        <NumberInput value={num(data, 'tryCount', 1)} min={0} fallback={1} onChange={(n) => onChange({ tryCount: n })} />
      </Field>
      <Field label="Timeout (milliseconds)">
        <NumberInput value={num(data, 'timeout', 500)} min={0} fallback={500} onChange={(n) => onChange({ timeout: n })} />
      </Field>
      <Checkbox
        checked={bool(data, 'throwError')}
        onChange={(v) => onChange({ throwError: v })}
        label="Throw an error if doesn't exist"
      />
    </InteractionBase>
  )
}
