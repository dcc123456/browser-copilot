/**
 * EditCookie — React port of Automa's EditCookie.vue (block: cookie).
 *
 * Get / set / remove cookies. For "get" there is a "get all cookies" toggle;
 * every action can be authored as raw JSON (a plain textarea standing in for
 * Automa's CodeMirror editor) or via plain fields (URL, name, value, path,
 * domain, sameSite, expiration date, httpOnly/secure). "get" additionally
 * shows the assign-to-variable output controls. Automa gates the form behind
 * a cookies-permission check; the editor always renders the form.
 *
 * @module workflow-editor/blocks/batchB/EditCookie
 */

import type { EditFormProps } from '../EditForms'
import SaveOutputs from './SaveOutputs'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

const TYPES = [
  { value: 'get', label: 'Get cookies' },
  { value: 'set', label: 'Set cookie' },
  { value: 'remove', label: 'Remove cookies' },
]

export default function EditCookie({ data, onChange }: EditFormProps) {
  const type = str(data, 'type') || 'get'
  const getAll = bool(data, 'getAll')
  const useJson = bool(data, 'useJson')
  const isGetOrSet = (type === 'get' && getAll) || type === 'set'
  const mdnAction = type === 'get' && getAll ? 'getAll' : type

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field>
        <Select value={type} onChange={(v) => onChange({ type: v })} options={TYPES} />
      </Field>

      {type === 'get' && (
        <Checkbox checked={getAll} onChange={(v) => onChange({ getAll: v })} label="Get all cookies" />
      )}

      <Checkbox checked={useJson} onChange={(v) => onChange({ useJson: v })} label="Use JSON format" />

      {useJson ? (
        <>
          <Field>
            <TextArea
              mono
              rows={6}
              value={str(data, 'jsonCode')}
              fallback={'{\n\n}'}
              onChange={(v) => onChange({ jsonCode: v })}
            />
          </Field>
          <a
            href={`https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/${mdnAction}`}
            rel="noopener noreferrer"
            target="_blank"
            style={{ display: 'inline-block', textDecoration: 'underline', marginBottom: 12 }}
          >
            See all available properties
          </a>
        </>
      ) : (
        <>
          <Field label="URL">
            <TextInput
              value={str(data, 'url')}
              placeholder="https://example.com/"
              onChange={(v) => onChange({ url: v })}
            />
          </Field>
          <Field label={`Name ${type === 'get' && !getAll ? '' : '(optional)'}`}>
            <TextInput
              value={str(data, 'name')}
              placeholder="site-cookie"
              onChange={(v) => onChange({ name: v })}
            />
          </Field>
          {type === 'set' && (
            <Field label="Value (optional)">
              <TextInput value={str(data, 'value')} placeholder="value" onChange={(v) => onChange({ value: v })} />
            </Field>
          )}
          <Field label="Path (optional)">
            <TextInput value={str(data, 'path')} placeholder="/" onChange={(v) => onChange({ path: v })} />
          </Field>
          {isGetOrSet && (
            <Field label="Domain (optional)">
              <TextInput
                value={str(data, 'domain')}
                placeholder=".example.com"
                onChange={(v) => onChange({ domain: v })}
              />
            </Field>
          )}
          {type === 'set' && (
            <>
              <Field label="sameSite (optional)">
                <TextInput
                  value={str(data, 'sameSite')}
                  placeholder="lax"
                  onChange={(v) => onChange({ sameSite: v })}
                />
              </Field>
              <Field label="expirationDate (seconds) (optional)">
                <TextInput
                  value={str(data, 'expirationDate')}
                  placeholder="3600"
                  onChange={(v) => onChange({ expirationDate: v })}
                />
              </Field>
            </>
          )}
          {(type === 'set' || (type === 'get' && getAll)) && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              {type === 'set' && (
                <Checkbox
                  checked={bool(data, 'httpOnly')}
                  onChange={(v) => onChange({ httpOnly: v })}
                  label="httpOnly"
                />
              )}
              <Checkbox checked={bool(data, 'secure')} onChange={(v) => onChange({ secure: v })} label="secure" />
            </div>
          )}
        </>
      )}

      {type === 'get' && (
        <div style={{ borderTop: '1px solid var(--bc-border)', paddingTop: 12 }}>
          <SaveOutputs data={data} onChange={onChange} />
        </div>
      )}
    </div>
  )
}
