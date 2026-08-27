/**
 * Automa-derived block catalog types.
 *
 * The catalog is auto-generated from Automa's `src/utils/shared.js` `tasks`
 * object (see `catalog.gen.mjs`) so block ids, English names, RemixIcon names,
 * categories, port counts, and default `data` stay byte-for-byte aligned with
 * Automa. Cloud-only blocks (Google Sheets/Drive, AI Workflow, block-package)
 * carry `cloud: true` and are filtered out of the palette.
 *
 * @module lib/workflow/blocks/types
 */

/** The seven Automa block categories. */
export type AutomaCategory =
  | 'interaction'
  | 'browser'
  | 'general'
  | 'onlineServices'
  | 'data'
  | 'conditions'
  | 'package'

/**
 * The Vue component Automa uses to render the node on the canvas. We mirror
 * the same set so the React node renderers can branch on identical values.
 */
export type BlockComponent =
  | 'BlockBasic'
  | 'BlockBasicWithFallback'
  | 'BlockConditions'
  | 'BlockDelay'
  | 'BlockElementExists'
  | 'BlockGroup'
  | 'BlockGroup2'
  | 'BlockLoopBreakpoint'
  | 'BlockNote'
  | 'BlockPackage'
  | 'BlockRepeatTask'

/** A single block definition, as extracted from Automa's `tasks`. */
export interface BlockCatalogEntry {
  /** Automa block id, e.g. `'click-element'` (Automa calls this `event-click`). */
  id: string
  /** English display name, e.g. `'Click element'`. */
  name: string
  /** English description (may be empty for blocks Automa leaves blank). */
  description: string
  /**
   * Icon spec:
   * - RemixIcon name: `'riFlashlightLine'`
   * - inline SVG path: `'path:M10 10...'`
   * - remote image: `'https://...'`
   */
  icon: string
  category: AutomaCategory
  /** Canvas node component family (maps to a React node renderer). */
  component: BlockComponent
  /** Name of the edit-form component, e.g. `'EditForms'`. Absent when `disableEdit`. */
  editComponent?: string
  /** Number of input (target) handles. */
  inputs: number
  /** Number of output (source) handles (1 for normal blocks; 2 for branches). */
  outputs: number
  /** Whether incoming connections are allowed. */
  allowedInputs?: boolean
  /** Maximum number of incoming connections. */
  maxConnection?: number
  /** Blocks with no edit form (e.g. `active-tab`). */
  disableEdit?: boolean
  /** Corner tag, e.g. `'AI'`. */
  tag?: string
  /** Keys whose values are offered as block output references downstream. */
  refDataKeys?: string[]
  /** Cloud-only block (Google/AI/package): hidden from the palette. */
  cloud?: boolean
  /** Default node `data` (Automa's own defaults — the runtime contract). */
  data: Record<string, unknown>
}

/** Light/dark hex colors for a category. */
export interface CategoryColors {
  bg: string
  border: string
}

/** Category metadata used by the palette, nodes, and minimap. */
export interface CategoryMeta {
  name: string
  light: CategoryColors
  dark: CategoryColors
}
