/**
 * EditLoopData — React port of Automa's EditLoopData.vue.
 *
 * Iterates over a table (data columns), a number range, a Google Sheet ref,
 * a variable, custom JSON data, or page elements. Custom data accepts JSON or
 * a CSV/XLSX import (Automa's data modal); elements use the shared
 * SelectorField and accept CSS or XPath.
 *
 * @module workflow-editor/blocks/batchC/EditLoopData
 */

import { useEffect, useRef, useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'
import { Checkbox, Expand, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import PopupField from '../shared/PopupField'
import { bool, num, str } from '../shared/InteractionBase'
import SelectorField from '../shared/SelectorField'
import { parseSpreadsheet } from '../../../lib/workflow/excel-parse'
import { id } from './shared'

/** Automa's cap on imported/pasted custom data. */
const MAX_LOOP_DATA_BYTES = 1024 * 1024

const LOOP_TYPES = [
  { value: 'data-columns', label: 'Table' },
  { value: 'numbers', label: 'Numbers' },
  { value: 'google-sheets', label: 'Google Sheets' },
  { value: 'variable', label: 'Variable' },
  { value: 'custom-data', label: 'Custom data' },
  { value: 'elements', label: 'Elements' },
]

export default function EditLoopData({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const [hasHeader, setHasHeader] = useState(true)
  const [importError, setImportError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const loopThrough = str(data, 'loopThrough') || 'data-columns'
  const resume = bool(data, 'resumeLastWorkflow')

  const patch = (p: Record<string, unknown>) => onChange(p)

  const importFile = async (file: File): Promise<void> => {
    setImportError('')
    if (file.size > MAX_LOOP_DATA_BYTES) {
      setImportError(bt('The file is larger than 1 MB.'))
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let imported: unknown[]
      if (file.type === 'application/json' || /\.json$/i.test(file.name)) {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
        // Automa wraps a single object so every iteration has one item.
        imported = Array.isArray(parsed) ? parsed : [parsed]
      } else {
        const spreadsheet = await parseSpreadsheet(bytes, file.name, { hasHeader })
        imported = hasHeader ? spreadsheet.rows : spreadsheet.rawRows
      }
      patch({ loopData: JSON.stringify(imported, null, 2).slice(0, MAX_LOOP_DATA_BYTES) })
    } catch {
      setImportError(bt('Could not read that file. Expected JSON or a .csv/.xlsx spreadsheet.'))
    }
  }
  // Automa seeds a short nanoid loop id on mount.
  useEffect(() => {
    if (!str(data, 'loopId')) onChange({ loopId: id(6) })
  }, [])

  // Cross-field clamp: from stays below to (and vice versa). NumberInput keeps
  // the field clearable while typing and normalizes on blur.
  const setFromNumber = (from: number) => {
    const to = num(data, 'toNumber', 10)
    patch({ fromNumber: from >= to ? to - 1 : from })
  }
  const setToNumber = (to: number) => {
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
        <TextInput
          value={str(data, 'loopId')}
          placeholder="Loop ID"
          onChange={(v) => patch({ loopId: v.replace(/\s/g, '') })}
        />
      </Field>

      <Field label="Loop through">
        <Select
          value={loopThrough}
          onChange={(v) => patch({ loopThrough: v })}
          options={LOOP_TYPES}
        />
      </Field>

      {loopThrough === 'google-sheets' && (
        <Field label="Reference key">
          <TextInput
            value={str(data, 'referenceKey')}
            placeholder="abc123"
            onChange={(v) => patch({ referenceKey: v })}
          />
        </Field>
      )}

      {loopThrough === 'variable' && (
        <Field label="Variable name">
          <TextInput
            value={str(data, 'variableName')}
            placeholder="abc123"
            onChange={(v) => patch({ variableName: v })}
          />
        </Field>
      )}

      {loopThrough === 'elements' && (
        <>
          <SelectorField
            label="Element selector"
            selector={str(data, 'elementSelector')}
            onSelector={(v) => patch({ elementSelector: v })}
            multiple
          />
          <Checkbox
            checked={bool(data, 'waitForSelector')}
            onChange={(v) => patch({ waitForSelector: v })}
            label="Wait for selector"
          />
          {bool(data, 'waitForSelector') && (
            <Field label="Selector timeout (ms)">
              <NumberInput
                value={num(data, 'waitSelectorTimeout', 5000)}
                min={0}
                fallback={5000}
                onChange={(n) => patch({ waitSelectorTimeout: n })}
              />
            </Field>
          )}
        </>
      )}

      {loopThrough === 'custom-data' && (
        <PopupField
          title="Custom data"
          summary={
            str(data, 'loopData').trim()
              ? `${str(data, 'loopData').length} ${bt('chars')}`
              : bt('None')
          }
          editLabel="Insert data"
          icon="lucide:Brackets"
          size="lg"
        >
          <p className="wf-form-note">
            {bt('Max file/data size is 1MB. Import a JSON/CSV/XLSX file or paste JSON below.')}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" className="wf-btn" onClick={() => fileInput.current?.click()}>
              {bt('Import file')}
            </button>
            <Checkbox checked={hasHeader} onChange={setHasHeader} label="First row is the header" />
            <input
              ref={fileInput}
              type="file"
              accept=".json,.csv,.xlsx,application/json,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importFile(file)
              }}
            />
          </div>
          {importError !== '' && <p className="text-xs text-err">{importError}</p>}
          <Field label="Custom data (JSON array)">
            <TextArea
              mono
              rows={16}
              value={str(data, 'loopData')}
              placeholder={'[\n  { "name": "Alice" },\n  { "name": "Bob" }\n]'}
              onChange={(v) => patch({ loopData: v.slice(0, MAX_LOOP_DATA_BYTES) })}
            />
          </Field>
        </PopupField>
      )}

      {loopThrough === 'numbers' && (
        <div className="flex gap-2">
          <Field label="From number">
            <NumberInput value={num(data, 'fromNumber', 1)} fallback={1} onChange={setFromNumber} />
          </Field>
          <Field label="To number">
            <NumberInput value={num(data, 'toNumber', 10)} fallback={10} onChange={setToNumber} />
          </Field>
        </div>
      )}

      {loopThrough !== 'numbers' && (
        <>
          <Field label="Max data to loop (0 to disable)" title="Max number of data to loop">
            <NumberInput
              value={
                typeof data.maxLoop === 'number' || typeof data.maxLoop === 'string'
                  ? (data.maxLoop as string | number)
                  : 0
              }
              fallback={0}
              onChange={(n) => patch({ maxLoop: n })}
            />
          </Field>
          {!resume && (
            <Field label="Start from index">
              <NumberInput
                value={
                  typeof data.startIndex === 'number' || typeof data.startIndex === 'string'
                    ? (data.startIndex as string | number)
                    : 0
                }
                placeholder="0"
                fallback={0}
                onChange={(n) => patch({ startIndex: n })}
              />
            </Field>
          )}
          <Checkbox
            checked={resume}
            onChange={(v) => patch({ resumeLastWorkflow: v })}
            label="Resume last workflow"
          />
          <Checkbox
            checked={bool(data, 'reverseLoop')}
            onChange={(v) => patch({ reverseLoop: v })}
            label="Reverse loop order"
          />
        </>
      )}

      <Expand title="Notes">
        <p className="wf-form-note">
          {bt(
            'Elements accept a CSS selector or an XPath expression. Google Sheets is not available: import a .xlsx/.csv file as custom data instead.',
          )}
        </p>
      </Expand>
    </div>
  )
}
