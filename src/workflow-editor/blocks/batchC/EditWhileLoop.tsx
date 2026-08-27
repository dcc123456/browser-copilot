/**
 * EditWhileLoop — React port of Automa's EditWhileLoop.vue.
 *
 * While-loop stores its condition tree directly on `data.conditions`
 * (OrGroup[]); the catalog default is `null`, meaning "not configured yet".
 * Automa seeds it with one OR group of two AND rows on mount. Editing happens
 * in a fold-out here instead of a modal (same data, simpler shell).
 *
 * @module workflow-editor/blocks/batchC/EditWhileLoop
 */

import { useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Field, TextArea } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import ConditionBuilder, { defaultWhileConditions, readGroups, type OrGroup } from './ConditionBuilder'

export default function EditWhileLoop({ data, onChange }: EditFormProps) {
  const [editing, setEditing] = useState(false)

  // Catalog default is `null`; initialize with Automa's default tree.
  const groups: OrGroup[] =
    data.conditions === null || data.conditions === undefined
      ? defaultWhileConditions()
      : readGroups(data.conditions)

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <button type="button" className="wf-btn-accent w-full" onClick={() => setEditing(!editing)}>
        {editing ? 'Close condition' : 'Edit condition'}
      </button>

      {editing && (
        <div style={{ marginTop: 8 }}>
          <ConditionBuilder value={groups} onChange={(g) => onChange({ conditions: g })} />
        </div>
      )}

      <p className="wf-form-note" style={{ marginTop: 8 }}>
        Blocks connected to the fallback handle run when the condition is false.
      </p>
    </div>
  )
}
