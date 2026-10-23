/**
 * EditRepeatTask — edit form for the `repeat-task` block.
 *
 * Automa edits the repeat count on the canvas itself (BlockRepeatTask.vue);
 * this port keeps the count in the standard form. The engine accepts both
 * `repeatFor` (editor/catalog shape) and `count` (chat/engine shape).
 *
 * @module workflow-editor/blocks/batchC/EditRepeatTask
 */

import { Field, NumberInput, TextArea } from '../shared/Field'
import { num, str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import type { EditFormProps } from '../EditForms'

export default function EditRepeatTask({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Repeat count" title="How many times the branch runs">
        <NumberInput
          value={num(data, 'repeatFor', 1)}
          min={0}
          fallback={1}
          onChange={(n) => onChange({ repeatFor: n })}
        />
      </Field>

      <p className="wf-form-note">
        {str(data, 'repeatFor') === '0' || num(data, 'repeatFor', 1) === 0
          ? bt('Zero runs the branch zero times and continues from the end output.')
          : bt(
              'The branch repeats this many times; after the last run the workflow continues from the end output.',
            )}
      </p>
    </div>
  )
}
