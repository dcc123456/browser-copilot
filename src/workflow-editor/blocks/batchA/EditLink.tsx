/**
 * EditLink — "Link" block form (open a link element).
 *
 * React port of Automa's EditLink.vue: the interaction skeleton plus an
 * "Open in new tab" checkbox. The catalog sets `disableMultiple: true` for this
 * block, so the "Select multiple elements" option is hidden.
 *
 * @module workflow-editor/blocks/batchA/EditLink
 */
import { Checkbox } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool } from '../shared/InteractionBase'

export default function EditLink({ data, onChange }: EditFormProps) {
  return (
    <InteractionBase data={data} onChange={onChange} hideMultiple>
      <Checkbox
        checked={bool(data, 'openInNewTab')}
        onChange={(v) => onChange({ openInNewTab: v })}
        label="Open in new tab"
      />
    </InteractionBase>
  )
}
