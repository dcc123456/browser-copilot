/**
 * Browser Copilot 自研的块目录类型定义。
 *
 * 该目录由本项目自行维护，不依赖任何第三方工作流源的源码文件生成。块 ID、
 * 英文名称、图标、分类、端口数量及默认 `data` 均由本项目掌控。仅云端块
 * （Google Sheets/Drive、AI Workflow、block-package）带有 `cloud: true`，
 * 并会被从调色板中过滤掉。
 *
 * @module lib/workflow/blocks/types
 */

/** 块的七个分类。 */
export type BlockCategory =
  | 'interaction'
  | 'browser'
  | 'general'
  | 'onlineServices'
  | 'data'
  | 'conditions'
  | 'package'

/**
 * React 画布节点渲染键。此即节点渲染器分支所依据的标识，对应各渲染组件。
 */
export type BlockComponent =
  | 'Default'
  | 'Conditions'
  | 'ElementExists'
  | 'RepeatTask'
  | 'Delay'
  | 'LoopBreakpoint'
  | 'Group'
  | 'Note'
  | 'Package'

/** 单个块定义条目，由本项目的块目录维护。 */
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
  category: BlockCategory
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
  /** Default node `data` (the runtime default contract defined by this catalog). */
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
