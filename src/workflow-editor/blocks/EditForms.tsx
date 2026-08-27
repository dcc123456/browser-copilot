/**
 * Registry mapping Automa's `editComponent` names (from the block catalog) to
 * their React implementations. Each dedicated form receives:
 *
 *   data     — the block's `data` payload (Automa shape)
 *   onChange — merge a patch object into the block data
 *   blockId  — the catalog block id (for blocks sharing a form)
 *
 * Dedicated forms are ported block-by-block in P4 from Automa's
 * `components/newtab/workflow/edit/Edit*.vue`. Blocks without an entry here
 * fall back to the generic key/value editor in BlockEditForm.
 *
 * @module workflow-editor/blocks/EditForms
 */

import type { ComponentType } from 'react'

export interface EditFormProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  blockId: string
}

export const EditForms: Record<string, ComponentType<EditFormProps>> = {
  // P4 fills this in, e.g.:
  // EditForms: EditFormsBlock,
  // EditNewTab,
  // ...
}
