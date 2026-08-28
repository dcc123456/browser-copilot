/**
 * EditNewTab — React port of Automa's EditNewTab.vue (block: new-tab).
 *
 * New tab URL (protocol + path), tab behavior checkboxes (update previously
 * opened tab, wait for load, set as active tab, tab group, custom user
 * agent), and a tab-zoom slider.
 *
 * @module workflow-editor/blocks/batchB/EditNewTab
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'

const PROTOCOLS = [
  { value: 'https://', label: 'HTTPS' },
  { value: 'http://', label: 'HTTP' },
  { value: 'ftp://', label: 'FTP' },
  { value: 'file://', label: 'FILE' },
  { value: 'mailto:', label: 'MAILTO' },
]

function isTemplateVariable(value: string): boolean {
  return !!value && value.includes('{{')
}

/** Split a stored url into protocol + path (Automa's parseUrl). */
function parseUrl(url: string): { protocol: string; path: string } {
  if (!url) return { protocol: 'https://', path: '' }
  if (isTemplateVariable(url)) return { protocol: 'https://', path: url }

  const protocolMatch = url.match(/^(https?:|ftp:|file:|mailto:)(\/\/)?/i)
  if (protocolMatch) {
    const protocolBase = (protocolMatch[1] ?? '').toLowerCase()
    const protocol = protocolBase + (protocolBase === 'mailto:' ? '' : '//')
    const path = url.slice(protocolMatch[0].length)
    return { protocol, path }
  }

  return { protocol: 'https://', path: url }
}

/** Strip a leading protocol the user typed into the path box. */
function cleanProtocol(path: string): string {
  if (!path) return path
  return path.replace(/^(https?:|ftp:|file:|mailto:)(\/\/)?/i, '')
}

export default function EditNewTab({ data, onChange }: EditFormProps) {
  const parsed = parseUrl(str(data, 'url'))

  const setUrlParts = (protocol: string, path: string) => {
    const cleanPath = cleanProtocol(path || '')
    onChange({ url: cleanPath ? protocol + cleanPath : protocol })
  }

  const zoom = num(data, 'tabZoom', 1)

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="New tab URL">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ width: 112, flexShrink: 0 }}>
            <Select
              value={parsed.protocol}
              onChange={(v) => setUrlParts(v, parsed.path)}
              options={PROTOCOLS}
            />
          </div>
          <TextInput
            value={parsed.path}
            placeholder="example.com/"
            onChange={(v) => setUrlParts(parsed.protocol, v)}
          />
        </div>
      </Field>

      <Checkbox
        checked={bool(data, 'updatePrevTab')}
        onChange={(v) => onChange({ updatePrevTab: v })}
        label="Update previously opened tab"
        title="Use the previously opened new tab instead of creating a new one"
      />
      <Checkbox
        checked={bool(data, 'waitTabLoaded')}
        onChange={(v) => onChange({ waitTabLoaded: v })}
        label="Wait until the tab is loaded"
      />
      <Checkbox
        checked={bool(data, 'active')}
        onChange={(v) => onChange({ active: v })}
        label="Set as active tab"
      />
      <Checkbox
        checked={bool(data, 'inGroup')}
        onChange={(v) => onChange({ inGroup: v })}
        label="Add tab to a group"
      />
      <Checkbox
        checked={bool(data, 'customUserAgent')}
        onChange={(v) => onChange({ customUserAgent: v })}
        label="Use custom User-Agent"
      />
      {bool(data, 'customUserAgent') && (
        <Field>
          <TextInput
            value={str(data, 'userAgent')}
            placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            onChange={(v) => onChange({ userAgent: v })}
          />
        </Field>
      )}

      <Field label={`Tab zoom (${Math.round(zoom * 100)}%)`}>
        <input
          type="range"
          min={0.25}
          max={4.5}
          step={0.25}
          value={zoom}
          onChange={(e) => onChange({ tabZoom: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </Field>
    </div>
  )
}
