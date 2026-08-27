/**
 * EditLoopData — React port of Automa's EditLoopData.vue.
 *
 * Iterates over a table (data columns), a number range, a Google Sheet ref,
 * a variable, custom JSON data, or page elements. File import / CSV parsing
 * (Papa) and the element picker are out of scope; custom data is edited as a
 * mono JSON textarea and elements use a plain selector input.
 *
 * @module workflow-editor/blocks/batchC/EditLoopData
 */

import { useEffect, useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import { id } from './shared'

const LOOP_TYPES = [
  { value: 'data-columns', label: 'Table' },
  { value: 'numbers', label: 'Numbers' },
  { value: 'google-sheets', label: 'Google Sheets' },
  { value: 'variable', label: 'Variable' },
  { value: 'custom-data', label: 'Custom data' },
  { value: 'elements', label: 'Elements' },
]

export default function EditLoopData({ data, onChange }: EditFormProps) {
  const [showData, setShowData] = useState(false)
  const loopThrough = str(data, 'loopThrough') || 'data-columns'
  const resume = bool(data, 'resumeLastWorkflow')

  const patch = (p: Record<string, unknown>) => onChange(p)
  // Automa seeds a short nanoid loop id on mount.
  useEffect(() => {
    if (!str(data, 'loopId')) onChange({ loopId: id(6) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setFromNumber = (v: string) => {
    const from = Number(v)
    const to = num(data, 'toNumber', 10)
    patch({ fromNumber: from >= to ? to - 1 : from })
  }
  const setToNumber = (v: string) => {
    const to = Number(v)
    const from = num(data, 'fromNumber', 1)
    patch({ toNumber: to <= from ? from + 1 : to })
  }

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => patch({ description: v })}
        />
      </Field>

      <Field label="Loop ID">
        <TextInput value={str(data, 'loopId')} placeholder="Loop ID" onChange={(v) => patch({ loopId: v.replace(/\s/g, '') })} />
      </Field>

      <Field label="Loop through">
        <Select value={loopThrough} onChange={(v) => patch({ loopThrough: v })} options={LOOP_TYPES} />
      </Field>

      {loopThrough === 'google-sheets' && (
        <Field label="Reference key">
          <TextInput value={str(data, 'referenceKey')} placeholder="abc123" onChange={(v) => patch({ referenceKey: v })} />
        </Field>
      )}

      {loopThrough === 'variable' && (
        <Field label="Variable name">
          <TextInput value={str(data, 'variableName')} placeholder="abc123" onChange={(v) => patch({ variableName: v })} />
        </Field>
      )}

      {loopThrough === 'elements' && (
        <>
          <Field label="Element selector">
            <TextArea
              mono
              value={str(data, 'elementSelector')}
              placeholder="CSS Selector or XPath"
              onChange={(v) => patch({ elementSelector: v })}
            />
          </Field>
          <Checkbox
            checked={bool(data, 'waitForSelector')}
            onChange={(v) => patch({ waitForSelector: v })}
            label="Wait for selector"
          />
          {bool(data, 'waitForSelector') && (
            <Field label="Selector timeout (ms)">
              <TextInput
                type="number"
                value={num(data, 'waitSelectorTimeout', 5000)}
                onChange={(v) => patch({ waitSelectorTimeout: Number(v) || 5000 })}
              />
            </Field>
          )}
        </>
      )}

      {loopThrough === 'custom-data' && (
        <>
          <button type="button" className="wf-btn-accent w-full" onClick={() => setShowData(!showData)}>
            {showData ? 'Close data' : 'Insert data'}
          </button>
          <p className="wf-form-note">Max file/data size is 1MB. Import a JSON/CSV file or paste JSON below.</p>
          {showData && (
            <Field label="Custom data (JSON array)">
              <TextArea
                mono
                rows={10}
                value={str(data, 'loopData')}
                placeholder={'[\n  { "name": "Alice" },\n  { "name": "Bob" }\n]'}
                onChange={(v) => patch({ loopData: v.slice(0, 1024 * 1024) })}
              />
            </Field>
          )}
        </>
      )}

      {loopThrough === 'numbers' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Field label="From number">
            <TextInput type="number" value={num(data, 'fromNumber', 1)} onChange={setFromNumber} />
          </Field>
          <Field label="To number">
            <TextInput type="number" value={num(data, 'toNumber', 10)} onChange={setToNumber} />
          </Field>
        </div>
      )}

      {loopThrough !== 'numbers' && (
        <>
          <Field label="Max data to loop (0 to disable)" title="Max number of data to loop">
            <TextInput
              type="number"
              value={typeof data.maxLoop === 'number' || typeof data.maxLoop === 'string' ? (data.maxLoop as string | number) : 0}
              onChange={(v) => patch({ maxLoop: v })}
            />
          </Field>
          {!resume && (
            <Field label="Start from index">
              <TextInput
                type="number"
                value={typeof data.startIndex === 'number' || typeof data.startIndex === 'string' ? (data.startIndex as string | number) : 0}
                placeholder="0"
                onChange={(v) => patch({ startIndex: v })}
              />
            </Field>
          )}
          <Checkbox checked={resume} onChange={(v) => patch({ resumeLastWorkflow: v })} label="Resume last workflow" />
          <Checkbox checked={bool(data, 'reverseLoop')} onChange={(v) => patch({ reverseLoop: v })} label="Reverse loop order" />
        </>
      )}

      <Expand title="Notes">
        <p className="wf-form-note">
          Google Sheets, file import (CSV/JSON), and the on-page element picker are not wired up in this build — use
          the reference key / selector text fields directly.
        </p>
      </Expand>
    </div>
  )
}
