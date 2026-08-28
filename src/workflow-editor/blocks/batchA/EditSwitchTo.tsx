/**
 * EditSwitchTo — "Switch frame" block form.
 *
 * React port of Automa's EditSwitchTo.vue: switches content-script context
 * between the main window and an iframe. Fields:
 *   - Description
 *   - Window type: Main window / Iframe
 *   - when Iframe: the iframe element selector (text input) with the shared
 *     pick/verify selector actions.
 *
 * Automa has no find-by dropdown here; the selector input accepts a CSS
 * selector or XPath and passes the default cssSelector find-by to the picker.
 *
 * @module workflow-editor/blocks/batchA/EditSwitchTo
 */
import { Field, Select, TextArea, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import { str } from '../shared/InteractionBase'
import ElSelectorActions from '../shared/ElSelectorActions'

export default function EditSwitchTo({ data, onChange }: EditFormProps) {
  const windowType = str(data, 'windowType') || 'main-window'
  const selector = str(data, 'selector')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Window type">
        <Select
          value={windowType}
          onChange={(v) => onChange({ windowType: v })}
          options={[
            { value: 'main-window', label: 'Main window' },
            { value: 'iframe', label: 'Iframe' },
          ]}
        />
      </Field>

      {windowType === 'iframe' && (
        <Field label="Element selector">
          <div className="wf-selector-row">
            <div style={{ flex: 1 }}>
              <TextInput
                value={selector}
                placeholder="CSS Selector or XPath"
                onChange={(v) => onChange({ selector: v })}
              />
            </div>
            <ElSelectorActions
              selector={selector}
              findBy={str(data, 'findBy') === 'xpath' ? 'xpath' : 'cssSelector'}
              onSelector={(sel) => onChange({ selector: sel })}
            />
          </div>
        </Field>
      )}
    </div>
  )
}
