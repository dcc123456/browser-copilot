/**
 * EditLoopBreakpoint — edit form for the `loop-breakpoint` block.
 *
 * Automa's BlockLoopBreakpoint.vue edits a loop id and a "Stop loop" checkbox.
 * The default (unchecked) skips the REST of the current item's body and moves
 * to the next item; "Stop loop" leaves the loop entirely.
 *
 * @module workflow-editor/blocks/batchC/EditLoopBreakpoint
 */

import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import type { EditFormProps } from '../EditForms'

export default function EditLoopBreakpoint({ data, onChange }: EditFormProps) {
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

      <Field label="Loop ID" title="Leave empty to target the innermost enclosing loop">
        <TextInput
          value={str(data, 'loopId')}
          placeholder="Leave empty for the innermost loop"
          onChange={(v) => onChange({ loopId: v.replace(/\s/g, '') })}
          noSlash
        />
      </Field>

      <Checkbox
        checked={bool(data, 'clearLoop')}
        onChange={(v) => onChange({ clearLoop: v })}
        label="Stop loop"
      />

      <p className="wf-form-note">
        {bool(data, 'clearLoop')
          ? bt('Stops the loop entirely and continues from its end output.')
          : bt('Skips the rest of this item and continues with the next item.')}
      </p>
    </div>
  )
}
