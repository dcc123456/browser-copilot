/**
 * Central registry mapping Automa's `editComponent` names (from the block
 * catalog) to their React form implementations. Each form receives
 * `{ data, onChange, blockId }` and renders the block's editable fields.
 *
 * The ~55 local block forms are ported from Automa's
 * `components/newtab/workflow/edit/Edit*.vue` and grouped into four batches by
 * category (interaction / browser / data-control-flow / general). Blocks
 * without an entry here fall back to the generic key/value editor in
 * BlockEditForm; cloud blocks are rejected earlier and never reach a form.
 *
 * @module workflow-editor/blocks/EditForms
 */

import type { ComponentType } from 'react'
import { BatchAForms } from './batchA'
import { BatchBForms } from './batchB'
import { BatchCForms } from './batchC'
import { BatchDForms } from './batchD'

export interface EditFormProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  blockId: string
}

/**
 * Merged editComponent → form map. The first definition wins on key collision,
 * so a collision is deterministic. A few catalog editComponents point at a
 * shared Vue component (EditInteractionBase) or use a different casing than the
 * form file; those are aliased explicitly afterward.
 */
function mergeBatches(
  ...maps: Record<string, ComponentType<EditFormProps>>[]
): Record<string, ComponentType<EditFormProps>> {
  const merged: Record<string, ComponentType<EditFormProps>> = {}
  for (const map of maps) {
    for (const [key, component] of Object.entries(map)) {
      if (!merged[key]) merged[key] = component
    }
  }

  // --- Catalog editComponent aliases --------------------------------------
  const alias = (name: string, source: string) => {
    if (!merged[name] && merged[source]) merged[name] = merged[source]!
  }
  // event-click & hover-element use Automa's shared EditInteractionBase.
  alias('EditInteractionBase', 'EditEventClick')
  // The element-scroll catalog entry names the component EditScrollElement.
  alias('EditScrollElement', 'EditElementScroll')
  // tab-url's catalog editComponent is EditTabURL (Vue file casing).
  alias('EditTabURL', 'EditTabUrl')

  return merged
}

export const EditForms: Record<string, ComponentType<EditFormProps>> = mergeBatches(
  BatchAForms,
  BatchBForms,
  BatchCForms,
  BatchDForms,
)
