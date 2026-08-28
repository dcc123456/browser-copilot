/**
 * EditCloseTab — React port of Automa's EditCloseTab.vue (block: close-tab).
 *
 * Close type (tab/window): for "tab" a close-active-tab checkbox plus a match
 * patterns URL input; for "window" a close-all-windows checkbox.
 *
 * @module workflow-editor/blocks/batchB/EditCloseTab
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

const CLOSE_TYPES = ['tab', 'window']

export default function EditCloseTab({ data, onChange }: EditFormProps) {
  const closeType = str(data, 'closeType') || 'tab'
  const activeTab = bool(data, 'activeTab')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Close">
        <Select value={closeType} onChange={(v) => onChange({ closeType: v })} options={CLOSE_TYPES} />
      </Field>

      {closeType === 'tab' ? (
        <>
          <Checkbox
            checked={activeTab}
            onChange={(v) => onChange({ activeTab: v })}
            label="Close active tab"
          />
          {!activeTab && (
            <div className="wf-field">
              <label>
                Match Patterns{' '}
                <a
                  title="Examples"
                  href="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns#examples"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-block' }}
                >
                  <i className="ri-information-line" />
                </a>
              </label>
              <TextInput
                value={str(data, 'url')}
                placeholder="http://example.com/*"
                onChange={(v) => onChange({ url: v })}
              />
            </div>
          )}
        </>
      ) : (
        <Checkbox
          checked={bool(data, 'allWindows')}
          onChange={(v) => onChange({ allWindows: v })}
          label="Close all windows"
        />
      )}
    </div>
  )
}
