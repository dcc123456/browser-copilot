/**
 * EditElementScroll — "Scroll element" block form.
 *
 * React port of Automa's EditScrollElement.vue. Beyond the interaction
 * skeleton:
 *   - horizontal / vertical scroll-amount number inputs (hidden while
 *     "Scroll into view" is on)
 *   - "Scroll into view", "Smooth scroll" checkboxes
 *   - "Increment horizontal/vertical scroll" checkboxes (hidden in
 *     scroll-into-view mode)
 *
 * @module workflow-editor/blocks/batchA/EditElementScroll
 */
import { Checkbox, Field, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, num } from '../shared/InteractionBase'

export default function EditElementScroll({ data, onChange }: EditFormProps) {
  const scrollIntoView = bool(data, 'scrollIntoView')

  return (
    <InteractionBase data={data} onChange={onChange}>
      {!scrollIntoView && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Field label="Scroll horizontal">
            <TextInput
              type="number"
              value={num(data, 'scrollX', 0)}
              onChange={(v) => onChange({ scrollX: Number(v) || 0 })}
            />
          </Field>
          <Field label="Scroll vertical">
            <TextInput
              type="number"
              value={num(data, 'scrollY', 0)}
              onChange={(v) => onChange({ scrollY: Number(v) || 0 })}
            />
          </Field>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Checkbox
          checked={scrollIntoView}
          onChange={(v) => onChange({ scrollIntoView: v })}
          label="Scroll into view"
        />
        <Checkbox checked={bool(data, 'smooth')} onChange={(v) => onChange({ smooth: v })} label="Smooth scroll" />
        {!scrollIntoView && (
          <>
            <Checkbox
              checked={bool(data, 'incX')}
              onChange={(v) => onChange({ incX: v })}
              label="Increment horizontal scroll"
            />
            <Checkbox
              checked={bool(data, 'incY')}
              onChange={(v) => onChange({ incY: v })}
              label="Increment vertical scroll"
            />
          </>
        )}
      </div>
    </InteractionBase>
  )
}
