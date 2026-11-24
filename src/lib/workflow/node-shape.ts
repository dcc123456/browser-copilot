/**
 * The canvas ↔ stored round-trip for one node.
 *
 * The editor keeps a resolved catalog entry next to the node's parameters, and
 * the stored file keeps the block id instead. Both directions have to preserve
 * one thing above all: **a block this build does not resolve must keep its
 * original id and label**. Rewriting it to `unknown` corrupts the graph on save
 * (the next load shows an empty card, and the operator the user placed is gone
 * for good).
 *
 * Pure and chrome-free so the round-trip is unit-testable; the editor owns
 * rendering.
 *
 * @module lib/workflow/node-shape
 */
import { BLOCK_BY_ID } from './blocks/palette'
import type { BlockCatalogEntry } from './blocks/types'
import type { WorkflowNode } from './types'

/** The fields the canvas carries for one node, independent of rendering. */
export interface CanvasNodeFields {
  /** The block id as written in the workflow file — never normalised away. */
  blockId: string
  /** The label the file had; only meaningful when the block is unknown here. */
  label: string
  blockData: Record<string, unknown>
}

/** Splits a stored node into what the canvas needs, preserving id and label. */
export function canvasFieldsOf(node: WorkflowNode): CanvasNodeFields {
  const record = (node.data ?? {}) as Record<string, unknown>
  const rawId = record['blockId']
  return {
    blockId: typeof rawId === 'string' && rawId !== '' ? rawId : node.label,
    label: node.label,
    blockData: Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'blockId' && key !== 'label'),
    ),
  }
}

/** Resolves the catalog entry the canvas renders for a block id. */
export function blockEntryOf(blockId: string): BlockCatalogEntry | undefined {
  return BLOCK_BY_ID.get(blockId)
}

/**
 * Rebuilds the stored node from the canvas fields.
 *
 * The block's own name wins for a KNOWN block (labels are display names derived
 * from the catalog), while an unknown block keeps whatever label the file had —
 * the id and the label are the only things left to recognise it by.
 */
export function storedNodeOf(
  id: string,
  position: { x: number; y: number },
  fields: CanvasNodeFields,
): WorkflowNode {
  const entry = blockEntryOf(fields.blockId)
  const label = entry?.name ?? (fields.label.trim() !== '' ? fields.label : fields.blockId)
  return {
    id,
    label,
    position,
    data: { ...fields.blockData, blockId: fields.blockId },
  }
}
