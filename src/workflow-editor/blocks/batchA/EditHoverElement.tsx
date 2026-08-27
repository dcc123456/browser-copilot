/**
 * EditHoverElement — "Hover element" block form.
 *
 * React port. Automa has no EditHoverElement.vue: the `hover-element` block
 * uses `EditInteractionBase` only. This is a thin wrapper rendering the shared
 * interaction skeleton with no extra fields.
 *
 * @module workflow-editor/blocks/batchA/EditHoverElement
 */
import type { EditFormProps } from '../EditForms'
import InteractionBase from '../shared/InteractionBase'

export default function EditHoverElement({ data, onChange }: EditFormProps) {
  return <InteractionBase data={data} onChange={onChange} />
}
