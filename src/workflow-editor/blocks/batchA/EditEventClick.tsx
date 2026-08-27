/**
 * EditEventClick — "Click element" block form.
 *
 * React port. In Automa the `event-click` block uses `EditInteractionBase`
 * directly (there is no dedicated EditEventClick.vue), so this is a thin
 * wrapper around the shared interaction skeleton: description + find-by +
 * selector (with pick/verify) + selector options, no extra fields.
 *
 * @module workflow-editor/blocks/batchA/EditEventClick
 */
import type { EditFormProps } from '../EditForms'
import InteractionBase from '../shared/InteractionBase'

export default function EditEventClick({ data, onChange }: EditFormProps) {
  return <InteractionBase data={data} onChange={onChange} />
}
