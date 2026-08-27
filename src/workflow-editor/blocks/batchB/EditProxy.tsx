/**
 * EditProxy — React port of Automa's EditProxy.vue (block: proxy).
 *
 * Host, port, bypass list and a "clear all proxies" checkbox. Note: the
 * chrome.proxy API is not available to Manifest V3 extensions, so the
 * runtime currently treats this block as a no-op; the settings below are
 * kept in block data for compatibility with imported Automa workflows.
 *
 * @module workflow-editor/blocks/batchB/EditProxy
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, TextArea, TextInput } from '../shared/Field'
import { bool, str } from '../shared/InteractionBase'

export default function EditProxy({ data, onChange }: EditFormProps) {
  const port = data.port
  const portValue = typeof port === 'string' || typeof port === 'number' ? port : 443

  return (
    <div className="wf-form">
      <p className="wf-form-note">
        Proxy is not supported in Manifest V3 (the chrome.proxy API is unavailable); this block is a
        placeholder and its settings have no effect.
      </p>

      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Host">
        <TextInput
          value={str(data, 'host')}
          placeholder="socks5://1.2.3.4:1080"
          onChange={(v) => onChange({ host: v })}
        />
      </Field>

      <Field label="Port">
        <TextInput value={portValue} placeholder="443" onChange={(v) => onChange({ port: v })} />
      </Field>

      <Field label="Bypass list">
        <TextArea
          value={str(data, 'bypassList')}
          placeholder="example1.com, example2.org"
          onChange={(v) => onChange({ bypassList: v })}
        />
      </Field>
      <p className="wf-form-note">Use commas (,) to separate URL</p>

      <Checkbox
        checked={bool(data, 'clearProxy')}
        onChange={(v) => onChange({ clearProxy: v })}
        label="Clear all proxies"
      />
    </div>
  )
}
