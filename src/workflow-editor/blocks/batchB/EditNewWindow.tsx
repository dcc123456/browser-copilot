/**
 * EditNewWindow — React port of Automa's EditNewWindow.vue (block: new-window).
 *
 * Window type, optional URL, window state, incognito toggle, and position/size
 * inputs (shown only for the "normal" state). Automa disables the incognito
 * checkbox until `extension.isAllowedIncognitoAccess()` resolves; the editor
 * leaves it enabled.
 *
 * @module workflow-editor/blocks/batchB/EditNewWindow
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const WINDOW_TYPES = ['normal', 'popup', 'panel']
const WINDOW_STATES = [
  { value: 'normal', label: 'Normal' },
  { value: 'minimized', label: 'Minimized' },
  { value: 'maximized', label: 'Maximized' },
  { value: 'fullscreen', label: 'Fullscreen' },
]

export default function EditNewWindow({ data, onChange }: EditFormProps) {
  const windowState = str(data, 'windowState') || 'normal'

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Type">
        <Select value={str(data, 'type') || 'normal'} onChange={(v) => onChange({ type: v })} options={WINDOW_TYPES} />
      </Field>

      <Field label="URL (optional)">
        <TextInput
          value={str(data, 'url')}
          placeholder="https://example.com"
          onChange={(v) => onChange({ url: v })}
        />
      </Field>

      <Field label="Window state">
        <Select value={windowState} onChange={(v) => onChange({ windowState: v })} options={WINDOW_STATES} />
      </Field>

      <Checkbox
        checked={bool(data, 'incognito')}
        onChange={(v) => onChange({ incognito: v })}
        label={
          <span>
            Set as an incognito window{' '}
            <span title="You must enable 'Allow in incognito' for this extension first">&#128712;</span>
          </span>
        }
      />

      {windowState === 'normal' && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Top">
              <NumberInput value={num(data, 'top')} fallback={0} onChange={(n) => onChange({ top: n })} />
            </Field>
            <Field label="Left">
              <NumberInput value={num(data, 'left')} fallback={0} onChange={(n) => onChange({ left: n })} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Height">
              <NumberInput value={num(data, 'height')} fallback={0} onChange={(n) => onChange({ height: n })} />
            </Field>
            <Field label="Width">
              <NumberInput value={num(data, 'width')} fallback={0} onChange={(n) => onChange({ width: n })} />
            </Field>
          </div>
          <p className="wf-form-note">Note: use 0 to disable</p>
        </>
      )}
    </div>
  )
}
