/**
 * EditSwitchTab — React port of Automa's EditSwitchTab.vue (block: switch-tab).
 *
 * Find tab by: match patterns / tab title / next tab / previous tab / tab
 * index, with a "create if there's no match" URL, an index input, and the
 * "set as active tab" checkbox.
 *
 * @module workflow-editor/blocks/batchB/EditSwitchTab
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const FIND_TYPES = [
  { value: 'match-patterns', label: 'Match patterns' },
  { value: 'tab-title', label: 'Tab title' },
  { value: 'next-tab', label: 'Next tab' },
  { value: 'prev-tab', label: 'Previous tab' },
  { value: 'tab-index', label: 'Tab index' },
]

export default function EditSwitchTab({ data, onChange }: EditFormProps) {
  const findTabBy = str(data, 'findTabBy') || 'match-patterns'
  const createIfNoMatch = bool(data, 'createIfNoMatch')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Find tab by">
        <Select value={findTabBy} onChange={(v) => onChange({ findTabBy: v })} options={FIND_TYPES} />
      </Field>

      {(findTabBy === 'match-patterns' || findTabBy === 'tab-title') && (
        <>
          {findTabBy === 'match-patterns' && (
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
                value={str(data, 'matchPattern')}
                placeholder="https://example.com/*"
                onChange={(v) => onChange({ matchPattern: v })}
              />
            </div>
          )}
          {findTabBy === 'tab-title' && (
            <Field label="Tab title">
              <TextInput
                value={str(data, 'tabTitle')}
                onChange={(v) => onChange({ tabTitle: v })}
              />
            </Field>
          )}

          <Checkbox
            checked={createIfNoMatch}
            onChange={(v) => onChange({ createIfNoMatch: v })}
            label="Create if there's no match"
          />
          {createIfNoMatch && (
            <Field label="New tab URL">
              <TextInput
                value={str(data, 'url')}
                placeholder="https://example.com"
                onChange={(v) => onChange({ url: v })}
              />
            </Field>
          )}
        </>
      )}

      {findTabBy === 'tab-index' && (
        <Field label="Index">
          <NumberInput value={num(data, 'tabIndex')} fallback={0} onChange={(n) => onChange({ tabIndex: n })} />
        </Field>
      )}

      <Checkbox
        checked={bool(data, 'activeTab')}
        onChange={(v) => onChange({ activeTab: v })}
        label="Set as active tab"
      />
    </div>
  )
}
