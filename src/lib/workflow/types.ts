/**
 * Domain types for automatable workflows.
 *
 * A workflow is a node-graph of blocks (browser steps, data transforms,
 * control flow, integrations, triggers) plus execution settings and the
 * variables it operates on. Kept in its own `lib/workflow/*` namespace so the
 * model, its validation rules, and its persistence stay together and separate
 * from the scheduler / conversation stores.
 *
 * @module lib/workflow/types
 */

/** The broad category a block belongs to, used for palette grouping. */
export type BlockCategory =
  | 'browser'
  | 'navigation'
  | 'data'
  | 'control-flow'
  | 'integration'
  | 'trigger'

/** A connection point on a block, for wiring nodes together in the editor. */
export interface HandleDefinition {
  id: string
  /** Human-readable name shown next to the handle. */
  label?: string
  /** Whether this handle receives or emits links. */
  type?: 'source' | 'target'
  /** Visual side of the node the handle sits on. */
  position?: 'left' | 'right' | 'top' | 'bottom'
}

/** A configurable input for a block. */
export interface ParamDefinition {
  name: string
  label?: string
  type?: 'string' | 'number' | 'boolean' | 'select' | 'json'
  /** Whether the user must fill this in for the block to run. */
  required?: boolean
  default?: unknown
  description?: string
  /** Choices when `type === 'select'`. */
  options?: string[]
}

/** A reusable, palette-installable block template. */
export interface BlockDefinition {
  id: string
  category: BlockCategory
  label?: string
  description?: string
  inputs?: HandleDefinition[]
  outputs?: HandleDefinition[]
  params?: ParamDefinition[]
}

/** A node placed on the canvas. */
export interface WorkflowNode {
  id: string
  label: string
  position: { x: number; y: number }
  /** Block-specific configuration, keyed by param name. */
  data: Record<string, unknown>
}

/** A directed connection between two {@link WorkflowNode}s. */
export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/** How a workflow gets launched. */
export interface WorkflowTrigger {
  type: 'manual' | 'scheduled' | 'github' | 'feishu' | 'context-menu' | 'visit-web'
  /** Cron-ish or interval text for scheduled triggers. */
  schedule?: string
  enabled?: boolean
  /**
   * Glob/regex text a URL must match for a `'visit-web'` trigger to fire. The
   * workflow is executed when the matched page commits navigation.
   */
  urlPattern?: string
  /**
   * Explicit context-menu item id for a `'context-menu'` trigger. When unset,
   * the workflow's own id is used as the menu item id.
   */
  menuItemId?: string
}

/** Execution / persistence options that travel with a workflow. */
export interface WorkflowSettings {
  /** Persist run transcripts to the run log. */
  saveLog: boolean
  debugMode: boolean
  /** Whether runs should post a notification when they settle. */
  notification: boolean
  /** Reuse the previous run's captured page state on the next run. */
  reuseLastState: boolean
  /** Target column name for table-backed workflows. */
  defaultColumnName?: string
}

/** A persisted workflow. */
export interface Workflow {
  id: string
  name: string
  description?: string
  /** Owning folder id, when workflows are grouped. */
  folderId?: string
  createdAt: number
  updatedAt: number
  /** React-flow-ish graph data. */
  drawflow: {
    nodes: WorkflowNode[]
    edges: WorkflowEdge[]
    position?: { x: number; y: number }
    zoom?: number
  }
  trigger?: WorkflowTrigger
  settings: WorkflowSettings
  /** Backing data-store reference (e.g. a spreadsheet table id). */
  table?: unknown
}

/** A named value a workflow reads and writes at runtime. */
export interface WorkflowVariable {
  id: string
  name: string
  value: unknown
}

/** Execution-time context handed to a running workflow. */
export interface WorkflowRunContext {
  workflowId: string
  trigger: WorkflowTrigger
  settings: WorkflowSettings
  /** Runtime variable values, keyed by variable name. */
  variables: Record<string, unknown>
  startedAt: number
  /** The active browser-page id, if one is captured. */
  pageId?: string
  /** Set to request early termination of the run. */
  cancelled?: boolean
}