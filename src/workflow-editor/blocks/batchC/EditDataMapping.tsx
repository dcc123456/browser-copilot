/**
 * EditDataMapping — React port of Automa's EditDataMapping.vue.
 *
 * Maps source properties to destination properties from either the table or a
 * variable. `data.sources` is a list of `{ id, name, destinations: [{id,name}] }`.
 * Automa edits it in a modal with table-column autocomplete on the source
 * name; the editor has no live column list, so both sides are plain text
 * inputs with add/remove buttons. Output goes to a table column or variable.
 *
 * Fields: dataSource ('table' | 'variable'), varSourceName, sources[],
 * dataColumn / saveData / assignVariable / variableName.
 *
 * @module workflow-editor/blocks/batchC/EditDataMapping
 */

import { useState } from 'react'
import { Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { AssignVariable, SaveToTable, id } from './shared'

interface Destination {
  id: string
  name: string
}
interface MapSource {
  id: string
  name: string
  destinations: Destination[]
}

function readSources(raw: unknown): MapSource[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      id: typeof s.id === 'string' ? s.id : id(4),
      name: typeof s.name === 'string' ? s.name : `source_${i + 1}`,
      destinations: Array.isArray(s.destinations)
        ? s.destinations
            .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
            .map((d, j) => ({ id: typeof d.id === 'string' ? d.id : id(4), name: typeof d.name === 'string' ? d.name : `dest_${j + 1}` }))
        : [],
    }))
}

export default function EditDataMapping({ data, onChange }: EditFormProps) {
  const [editing, setEditing] = useState(false)
  const dataSource = str(data, 'dataSource') || 'table'
  const sources = readSources(data.sources)

  const commitSources = (next: MapSource[]) => onChange({ sources: next })

  const addSource = () => {
    const sid = id(4)
    commitSources([...sources, { id: sid, name: `source_${sid}`, destinations: [] }])
  }
  const removeSource = (index: number) => {
    const next = sources.slice()
    next.splice(index, 1)
    commitSources(next)
  }
  const renameSource = (index: number, name: string) => {
    const next = sources.slice()
    next[index] = { ...next[index]!, name }
    commitSources(next)
  }
  const addDestination = (sourceIndex: number) => {
    const did = id(4)
    const next = sources.slice()
    const source = next[sourceIndex]!
    next[sourceIndex] = { ...source, destinations: [...source.destinations, { id: did, name: `dest_${did}` }] }
    commitSources(next)
  }
  const removeDestination = (sourceIndex: number, destIndex: number) => {
    const next = sources.slice()
    const source = next[sourceIndex]!
    const destinations = source.destinations.slice()
    destinations.splice(destIndex, 1)
    next[sourceIndex] = { ...source, destinations }
    commitSources(next)
  }
  const renameDestination = (sourceIndex: number, destIndex: number, name: string) => {
    const next = sources.slice()
    const source = next[sourceIndex]!
    const destinations = source.destinations.slice()
    destinations[destIndex] = { ...destinations[destIndex]!, name }
    next[sourceIndex] = { ...source, destinations }
    commitSources(next)
  }

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Data source">
        <Select
          value={dataSource}
          onChange={(v) => onChange({ dataSource: v })}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'variable', label: 'Variable' },
          ]}
        />
      </Field>

      {dataSource === 'variable' && (
        <Field label="Variable name" title="Variable name">
          <TextInput value={str(data, 'varSourceName')} placeholder="abc123" onChange={(v) => onChange({ varSourceName: v })} />
        </Field>
      )}

      <button type="button" className="wf-btn-accent w-full" onClick={() => setEditing(!editing)}>
        {editing ? 'Close data map' : 'Edit data map'}
      </button>

      {editing && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', fontWeight: 600, gap: 8 }}>
            <div style={{ flex: 1 }}>Source</div>
            <div style={{ flex: 1 }}>Destination</div>
          </div>
          {sources.map((source, sIndex) => (
            <div
              key={source.id}
              style={{ borderTop: '1px solid var(--bc-border, #ccc)', padding: '8px 0', display: 'flex', gap: 8 }}
            >
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
                <TextInput value={source.name} placeholder="Source property" onChange={(v) => renameSource(sIndex, v)} />
                <IconButton icon="ri-delete-bin-line" title="Remove source" onClick={() => removeSource(sIndex)} />
              </div>
              <div style={{ flex: 1 }}>
                {source.destinations.map((dest, dIndex) => (
                  <div key={dest.id} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                    <TextInput value={dest.name} placeholder="Destination property" onChange={(v) => renameDestination(sIndex, dIndex, v)} />
                    <IconButton
                      icon="ri-delete-bin-line"
                      title="Remove destination"
                      onClick={() => removeDestination(sIndex, dIndex)}
                    />
                  </div>
                ))}
                <button type="button" className="wf-btn-accent" onClick={() => addDestination(sIndex)}>
                  <i className="ri-add-line" /> Add destination
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="wf-btn-accent" onClick={addSource}>
            <i className="ri-add-line" /> Add source
          </button>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <SaveToTable data={data} onChange={onChange} />
        <AssignVariable data={data} onChange={onChange} />
      </div>
    </div>
  )
}
