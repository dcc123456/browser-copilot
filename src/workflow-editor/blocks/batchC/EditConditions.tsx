/**
 * EditConditions — React port of Automa's EditConditions.vue.
 *
 * The conditions block has a list of named output "paths"; each path has its
 * own condition tree (OR groups of AND rows). The canvas draws one output
 * handle per path (`<blockId>-output-<pathId>`). This form lists the paths
 * with add/remove/rename and opens a per-path ConditionBuilder inline;
 * dragging to reorder and the auto edge cleanup are handled by the canvas.
 *
 * @module workflow-editor/blocks/batchC/EditConditions
 */

import { useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, IconButton, NumberInput, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import ConditionBuilder, { readGroups, type OrGroup } from './ConditionBuilder'
import { id } from './shared'

interface ConditionPath {
  id: string
  name: string
  conditions: OrGroup[]
}

function readPaths(raw: unknown): ConditionPath[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p, index) => ({
      id: typeof p.id === 'string' ? p.id : id(6),
      name: typeof p.name === 'string' ? p.name : `Path ${index + 1}`,
      conditions: Array.isArray(p.conditions) ? (p.conditions as OrGroup[]) : [],
    }))
}

export default function EditConditions({ data, onChange }: EditFormProps) {
  const paths = readPaths(data.conditions)
  const [openPath, setOpenPath] = useState<number | null>(paths.length === 1 ? 0 : null)

  const commit = (next: ConditionPath[]) => onChange({ conditions: next })

  const addPath = () => {
    if (paths.length >= 20) return
    const index = paths.length
    commit([...paths, { id: id(8), name: `Path ${index + 1}`, conditions: [] }])
    setOpenPath(index)
  }
  const removePath = (index: number) => {
    const next = paths.slice()
    next.splice(index, 1)
    commit(next)
    if (openPath === index) setOpenPath(null)
  }
  const renamePath = (index: number, name: string) => {
    const next = paths.slice()
    next[index] = { ...next[index]!, name }
    commit(next)
  }
  const setPathConditions = (index: number, conditions: OrGroup[]) => {
    const next = paths.slice()
    next[index] = { ...next[index]!, conditions }
    commit(next)
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
        <button type="button" className="wf-btn-accent" disabled={paths.length >= 20} onClick={addPath}>
          <i className="ri-add-line" /> Add path
        </button>
      </div>

      {paths.length === 0 && (
        <p className="wf-form-note">No condition paths yet — add one to create an output branch.</p>
      )}

      {paths.map((path, index) => (
        <div
          key={path.id}
          style={{ border: '1px solid var(--bc-border, #ccc)', borderRadius: 8, padding: 8, marginBottom: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ri-guide-line" />
            <TextInput value={path.name} placeholder={`Path ${index + 1}`} onChange={(v) => renamePath(index, v)} />
            <IconButton icon="ri-pencil-line" title="Edit condition" onClick={() => setOpenPath(openPath === index ? null : index)} />
            <IconButton icon="ri-delete-bin-line" title="Delete path" onClick={() => removePath(index)} />
          </div>
          {openPath === index && (
            <div style={{ marginTop: 8 }}>
              <ConditionBuilder value={readGroups(path.conditions)} onChange={(g) => setPathConditions(index, g)} />
            </div>
          )}
        </div>
      ))}

      <Expand title="Settings" defaultOpen={false}>
        <Checkbox
          checked={bool(data, 'retryConditions')}
          onChange={(v) => onChange({ retryConditions: v })}
          label="Retry if no conditions are met"
        />
        {bool(data, 'retryConditions') && (
          <>
            <Field label="Times">
              <NumberInput value={num(data, 'retryCount', 10)} min={0} fallback={10} onChange={(n) => onChange({ retryCount: n })} />
            </Field>
            <Field label="Timeout (ms)">
              <NumberInput value={num(data, 'retryTimeout', 1000)} min={0} fallback={1000} onChange={(n) => onChange({ retryTimeout: n })} />
            </Field>
          </>
        )}
      </Expand>
    </div>
  )
}
