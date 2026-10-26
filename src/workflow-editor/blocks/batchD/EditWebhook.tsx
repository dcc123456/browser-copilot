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

import { CircleX } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import Modal from '../../ui/Modal'
import { bool, num, str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const NO_BODY = ['GET', 'HEAD']
const BODY_PLACEHOLDER = '{\n  "key": "value"\n}'

type RequestTab = 'headers' | 'body' | 'response'

interface Header {
  name: string
  value: string
}

function asHeaders(value: unknown): Header[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    .map((h) => ({
      name: typeof h.name === 'string' ? h.name : '',
      value: typeof h.value === 'string' ? h.value : '',
    }))
}

export default function EditWebhook({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const method = str(data, 'method') || 'POST'
  const contentType = str(data, 'contentType') || 'json'
  const responseType = str(data, 'responseType') || 'json'
  const headers = asHeaders(data.headers)
  const hasBody = !NO_BODY.includes(method)

  const [tab, setTab] = useState<RequestTab>('headers')
  const [bodyOpen, setBodyOpen] = useState(false)
  // Automa resets the tab when the method loses its body; deriving it keeps the
  // strip and the panel in sync without a second effect.
  const activeTab: RequestTab = tab === 'body' && !hasBody ? 'headers' : tab

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
        <NumberInput
          value={num(data, 'timeout', 10000)}
          fallback={0}
          onChange={(n) => onChange({ timeout: n })}
        />
      </Field>

      <div
        className="mt-2 flex items-stretch gap-1 rounded-lg border border-border bg-sunken p-1"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'headers'}
          className={`flex-1 rounded-md px-4 py-2 text-[13px] transition-colors ${
            activeTab === 'headers'
              ? 'bg-panel font-semibold text-ink'
              : 'text-muted hover:bg-hover hover:text-ink'
          }`}
          onClick={() => setTab('headers')}
        >
          {bt('Headers')}
        </button>
        {hasBody && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'body'}
            className={`flex-1 rounded-md px-4 py-2 text-[13px] transition-colors ${
              activeTab === 'body'
                ? 'bg-panel font-semibold text-ink'
                : 'text-muted hover:bg-hover hover:text-ink'
            }`}
            onClick={() => setTab('body')}
          >
            {bt('Body')}
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'response'}
          className={`flex-1 rounded-md px-4 py-2 text-[13px] transition-colors ${
            activeTab === 'response'
              ? 'bg-panel font-semibold text-ink'
              : 'text-muted hover:bg-hover hover:text-ink'
          }`}
          onClick={() => setTab('response')}
        >
          {bt('Response')}
        </button>
      </div>

      {activeTab === 'headers' && (
        <div className="mt-3 grid grid-cols-7 items-center gap-2">
          {headers.map((h, i) => (
            <Fragment key={i}>
              <div className="wf-field col-span-3 mb-0!">
                <TextInput
                  value={h.name}
                  placeholder={`${bt('Header')} ${i + 1}`}
                  onChange={(v) => updateHeader(i, { name: v })}
                />
              </div>
              <div className="wf-field col-span-3 mb-0!">
                <TextInput
                  value={h.value}
                  placeholder={bt('Value')}
                  onChange={(v) => updateHeader(i, { value: v })}
                />
              </div>
              <button
                type="button"
                className="col-span-1 inline-flex h-8 w-8 items-center justify-center justify-self-center rounded-md text-faint hover:bg-hover hover:text-ink"
                title={bt('Remove header')}
                aria-label={bt('Remove header')}
                onClick={() => removeHeader(i)}
              >
                <CircleX size={16} />
              </button>
            </Fragment>
          ))}
          <div className="col-span-4 mt-2">
            <button
              type="button"
              className="inline-flex w-full items-center justify-center rounded-lg border border-border bg-panel px-3 py-2 text-[13px] font-medium text-ink hover:bg-hover"
              onClick={addHeader}
            >
              {bt('Add header')}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'body' && (
        <pre
          className="mt-3 max-h-80 min-h-20 cursor-pointer overflow-auto whitespace-pre rounded-lg border border-border bg-panel-2 p-4 font-mono text-xs leading-relaxed text-ink"
          role="button"
          tabIndex={0}
          title={bt('Edit body')}
          aria-label={bt('Edit body')}
          onClick={() => setBodyOpen(true)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            setBodyOpen(true)
          }}
        >
          {str(data, 'body').trim() ? (
            str(data, 'body')
          ) : (
            <span className="text-faint">{BODY_PLACEHOLDER}</span>
          )}
        </pre>
      )}

      {activeTab === 'response' && (
        <div className="mt-3">
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
              <TextInput
                value={str(data, 'variableName')}
                placeholder="Variable name"
                onChange={(v) => onChange({ variableName: v })}
                noSlash
              />
            </Field>
          )}
          <Checkbox
            checked={bool(data, 'saveData')}
            onChange={(v) => onChange({ saveData: v })}
            label="Save response to a table"
          />
          {bool(data, 'saveData') && (
            <Field label="Column name">
              <TextInput
                value={str(data, 'dataColumn')}
                placeholder="Column name"
                onChange={(v) => onChange({ dataColumn: v })}
                noSlash
              />
            </Field>
          )}
        </div>
      )}

      <Modal
        open={bodyOpen}
        onClose={() => setBodyOpen(false)}
        title={bt('Request body')}
        icon="lucide:FileText"
        size="lg"
      >
        <Field label="Body">
          <TextArea
            mono
            rows={14}
            value={str(data, 'body')}
            placeholder={BODY_PLACEHOLDER}
            onChange={(v) => onChange({ body: v })}
          />
        </Field>
      </Modal>
    </div>
  )
}
