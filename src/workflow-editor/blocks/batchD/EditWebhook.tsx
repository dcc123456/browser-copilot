/**
 * EditWebhook — React port of Automa's EditWebhook.vue (HTTP Request block).
 *
 * Method select (GET/POST/...), URL, content type, timeout, an editable header
 * list (name/value rows — Automa stores `headers` as `{ name, value }[]`), a
 * JSON body textarea (hidden for GET/HEAD), and response handling (response
 * type, data path, assign to variable / save to table).
 *
 * @module workflow-editor/blocks/batchD/EditWebhook
 */

import { useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const NO_BODY = ['GET', 'HEAD']

interface Header {
  name: string
  value: string
}

function asHeaders(value: unknown): Header[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    .map((h) => ({ name: typeof h.name === 'string' ? h.name : '', value: typeof h.value === 'string' ? h.value : '' }))
}

export default function EditWebhook({ data, onChange }: EditFormProps) {
  const method = str(data, 'method') || 'POST'
  const contentType = str(data, 'contentType') || 'json'
  const responseType = str(data, 'responseType') || 'json'
  const headers = asHeaders(data.headers)
  const hasBody = !NO_BODY.includes(method)

  const [tab, setTab] = useState<'headers' | 'body' | 'response'>('headers')

  const setHeaders = (next: Header[]) => onChange({ headers: next })
  const updateHeader = (index: number, patch: Partial<Header>) => {
    const next = headers.map((h, i) => (i === index ? { ...h, ...patch } : h))
    setHeaders(next)
  }
  const addHeader = () => setHeaders([...headers, { name: '', value: '' }])
  const removeHeader = (index: number) => setHeaders(headers.filter((_, i) => i !== index))

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Request method">
        <Select
          value={method}
          onChange={(v) => onChange({ method: v })}
          options={METHODS.map((m) => ({ value: m, label: m }))}
        />
      </Field>

      <Field label="Request URL *">
        <TextArea
          mono
          value={str(data, 'url')}
          placeholder="http://api.example.com"
          onChange={(v) => onChange({ url: v })}
        />
      </Field>

      <Field label="Content type">
        <Select
          value={contentType}
          onChange={(v) => onChange({ contentType: v })}
          options={[
            { value: 'text', label: 'text/plain' },
            { value: 'json', label: 'application/json' },
            { value: 'form-data', label: 'multipart/form-data' },
            { value: 'form', label: 'application/x-www-form-urlencoded' },
          ]}
        />
      </Field>

      <Field label="Timeout (ms) (0 to disable)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 10000)}
          onChange={(v) => onChange({ timeout: Number(v) || 0 })}
        />
      </Field>

      <div className="wf-tabs">
        <button
          type="button"
          className={tab === 'headers' ? 'wf-tab wf-tab-active' : 'wf-tab'}
          onClick={() => setTab('headers')}
        >
          Headers
        </button>
        {hasBody && (
          <button
            type="button"
            className={tab === 'body' ? 'wf-tab wf-tab-active' : 'wf-tab'}
            onClick={() => setTab('body')}
          >
            Body
          </button>
        )}
        <button
          type="button"
          className={tab === 'response' ? 'wf-tab wf-tab-active' : 'wf-tab'}
          onClick={() => setTab('response')}
        >
          Response
        </button>
      </div>

      {tab === 'headers' && (
        <div className="wf-headers">
          {headers.map((h, i) => (
            <div className="wf-header-row" key={i}>
              <TextInput value={h.name} placeholder={`Header ${i + 1}`} onChange={(v) => updateHeader(i, { name: v })} />
              <TextInput value={h.value} placeholder="Value" onChange={(v) => updateHeader(i, { value: v })} />
              <button type="button" className="wf-icon-btn" title="Remove header" onClick={() => removeHeader(i)}>
                <i className="ri-close-circle-line" />
              </button>
            </div>
          ))}
          <button type="button" className="wf-btn wf-btn-block" onClick={addHeader}>
            Add header
          </button>
        </div>
      )}

      {tab === 'body' && hasBody && (
        <Field label="Body">
          <TextArea
            mono
            rows={8}
            value={str(data, 'body')}
            placeholder={'{\n  "key": "value"\n}'}
            onChange={(v) => onChange({ body: v })}
          />
        </Field>
      )}

      {tab === 'response' && (
        <div className="wf-tab-body">
          <Field label="Response type">
            <Select
              value={responseType}
              onChange={(v) => onChange({ responseType: v })}
              options={[
                { value: 'json', label: 'JSON' },
                { value: 'text', label: 'Text' },
                { value: 'base64', label: 'Base64' },
              ]}
            />
          </Field>
          {responseType === 'json' && (
            <Field label="Data path">
              <TextArea
                mono
                value={str(data, 'dataPath')}
                placeholder="path.to.data"
                onChange={(v) => onChange({ dataPath: v })}
              />
            </Field>
          )}
          <Checkbox
            checked={bool(data, 'assignVariable')}
            onChange={(v) => onChange({ assignVariable: v })}
            label="Assign response to a variable"
          />
          {bool(data, 'assignVariable') && (
            <Field label="Variable name">
              <TextInput value={str(data, 'variableName')} placeholder="Variable name" onChange={(v) => onChange({ variableName: v })} />
            </Field>
          )}
          <Checkbox checked={bool(data, 'saveData')} onChange={(v) => onChange({ saveData: v })} label="Save response to a table" />
          {bool(data, 'saveData') && (
            <Field label="Column name">
              <TextInput value={str(data, 'dataColumn')} placeholder="Column name" onChange={(v) => onChange({ dataColumn: v })} />
            </Field>
          )}
        </div>
      )}
    </div>
  )
}
