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
  'browser' | 'navigation' | 'data' | 'control-flow' | 'integration' | 'trigger'

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

/**
 * A workflow INPUT: a named value the workflow needs but cannot produce on its
 * own — the keyword to search for, the city to look up.
 *
 * Declared on the trigger (and/or on a `parameter-prompt` block) and resolved
 * at run time, so the recorded graph carries `{{name}}` references instead of
 * frozen literals. `defaultValue` is what the run uses when nothing else
 * supplies the value, which is what keeps a generated workflow runnable as
 * generated while still being editable.
 *
 * The shape mirrors Automa's parameter records so an imported workflow's
 * parameters survive; it lives here rather than in the editor component
 * because the engine, the storage layer and the operator bridge all need it
 * and none of them may import a `.tsx`.
 */
export interface WorkflowParameter {
  id?: string
  name: string
  /** `'string'` | `'number'` | `'json'` | `'checkbox'`; free-form for imports. */
  type: string
  description?: string
  defaultValue?: string
  placeholder?: string
  /**
   * Marks a credential input. Set when a user-typed account/password was
   * captured during generation, so the value lives in the trigger variable set
   * (as `defaultValue`) and is referenceable via `{{name}}` at replay. Mirrors
   * the `secret` flag on stored credential fields (`lib/storage`, `DataTab`).
   */
  secret?: boolean
  data?: { required?: boolean; [key: string]: unknown }
}

/** How a workflow gets launched. */
export interface WorkflowTrigger {
  /**
   * Launch type. The editor's trigger block (the Automa-style source of
   * truth inside the graph) emits the `interval` / `date` / `specific-day` /
   * `on-startup` / `keyboard-shortcut` / `element-change` kinds; `scheduled`,
   * `github` and `feishu` come from other creation paths. The top-level field
   * is a denormalized mirror of the trigger block (see `triggerFromNodes`).
   */
  type:
    | 'manual'
    | 'scheduled'
    | 'interval'
    | 'date'
    | 'specific-day'
    | 'on-startup'
    | 'keyboard-shortcut'
    | 'context-menu'
    | 'visit-web'
    | 'element-change'
    | 'github'
    | 'feishu'
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
  /**
   * The workflow's declared inputs, mirrored from the trigger node's
   * `data.parameters` exactly like the rest of this interface.
   *
   * Read at run time to seed the variable scope: a `{{keyword}}` reference
   * recorded during generation has nothing else to resolve against, because no
   * caller passes `variables` into `executeWorkflow`. Without this mirror a
   * generated workflow would replay its references as empty strings.
   */
  parameters?: WorkflowParameter[]
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
  /**
   * Element-wait window (ms) force-enabled on interaction blocks for EVERY run
   * (not just debug). Defaults to {@link DEFAULT_WAIT_MS} (2000) when unset;
   * set 0 to disable the rewrite for this workflow.
   */
  defaultWaitMs?: number
  /**
   * Where this workflow's graph came from, when it was saved from the
   * generation card (`chat-generate` = operator draft, `chat-history` =
   * compiled action history). Absent for editor/imported workflows. Lets the
   * run gate and future stats treat generated graphs differently from
   * hand-tuned ones without a separate registry.
   */
  provenance?: 'chat-generate' | 'chat-history'
  /**
   * The page the generation session first acted on (http(s) URL).
   *
   * A generated graph with no navigation node before its first element action
   * can only replay on THAT page — the manual trigger drives whatever tab is
   * active. The run gate reads this to warn the user before the workflow
   * fails on the wrong page; the engine emits a softer same-shape hint when
   * the tab it lands on is a different origin.
   */
  generationOriginUrl?: string
  /**
   * Which execution regime this workflow runs under (`lib/workflow/reliability`).
   * Absent means "derive": a generation provenance implies `generated-strict`,
   * everything else `compat`. An explicit value always wins.
   */
  reliabilityMode?: import('./reliability').WorkflowReliabilityMode
  /**
   * The workflow's goal contract (`lib/workflow/reliability`): what "success"
   * means, as checkable conditions. Required for `generated-strict` (the
   * generated validator blocks a strict workflow without one), ignored by
   * `compat`.
   */
  goalSpec?: import('./reliability').WorkflowGoalSpec
  /**
   * Non-blocking reliability / runnability findings captured at save time.
   * These NEVER prevent the workflow from being saved: they are surfaced on
   * the save card so the user can either run AI debug or fix the graph
   * manually. A workflow with warnings is still persisted as-is.
   */
  saveWarnings?: string[]
}

/** A persisted workflow. */
export interface Workflow {
  id: string
  name: string
  description?: string
  /**
   * 目标与执行步骤说明（生成时写下的"这个工作流做什么、按什么顺序做"）。
   * AI 调试的复演/审计用它理解每一步的意图——没有它，调试智能体只能从
   * 参数里猜。由对话生成路径自动写入；编辑器可留空（调试时回退到节点
   * description 拼装）。
   */
  plan?: string
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
