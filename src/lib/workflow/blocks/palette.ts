/**
 * Palette-facing selectors over the generated catalog.
 *
 * The catalog contains *every* Automa block (including cloud-only ones that
 * are hidden); the editor/palette consumes the filtered, ordered views here so
 * cloud blocks never surface in the UI.
 *
 * @module lib/workflow/blocks/palette
 */

import { BLOCK_CATALOG, CATEGORY_META } from './catalog'
import { CUSTOM_BLOCKS } from './custom'
import type { AutomaCategory, BlockCatalogEntry } from './types'

/**
 * Blocks shown in the palette / insertable on the canvas: every non-cloud
 * Automa catalog block, followed by Browser-Copilot's own extension blocks
 * (see `custom.ts`). Cloud blocks stay hidden.
 */
export const PALETTE_BLOCKS: BlockCatalogEntry[] = [
  ...BLOCK_CATALOG.filter((b) => !b.cloud),
  ...CUSTOM_BLOCKS,
]

/** Lookup by block id for *palette* blocks (cloud blocks intentionally absent). */
export const BLOCK_BY_ID: Map<string, BlockCatalogEntry> = new Map(
  PALETTE_BLOCKS.map((b) => [b.id, b]),
)

/**
 * Full catalog lookup, including cloud blocks (used to detect unsupported ids
 * and to resolve display names during migration). Extension blocks are merged
 * in too so ids like `ai-agent` resolve like any Automa block.
 */
export const CATALOG_BY_ID: Map<string, BlockCatalogEntry> = new Map([
  ...BLOCK_CATALOG.map((b) => [b.id, b] as const),
  ...CUSTOM_BLOCKS.map((b) => [b.id, b] as const),
])

/** Category display order, mirroring Automa's palette grouping. */
const CATEGORY_ORDER: AutomaCategory[] = [
  'general',
  'browser',
  'interaction',
  'data',
  'conditions',
  'onlineServices',
  'package',
]

/** Categories that currently contain at least one palette block, in display order. */
export const PALETTE_CATEGORIES: AutomaCategory[] = CATEGORY_ORDER.filter((cat) =>
  PALETTE_BLOCKS.some((b) => b.category === cat),
)

/** Palette blocks grouped by category (ordered, empty categories omitted). */
export function blocksByCategory(): { category: AutomaCategory; blocks: BlockCatalogEntry[] }[] {
  return PALETTE_CATEGORIES.map((category) => ({
    category,
    blocks: PALETTE_BLOCKS.filter((b) => b.category === category),
  }))
}

export { CATEGORY_META }
