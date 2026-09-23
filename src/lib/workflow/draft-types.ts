/**
 * The workflow-generation draft shape.
 *
 * Lives in `lib/` rather than next to the background handler that mutates it,
 * because the draft is *persisted* (see `draft-storage`) and therefore must be
 * describable without pulling any background module into the storage layer.
 *
 * @module lib/workflow/draft-types
 */

import type { WorkflowEdge, WorkflowNode } from './types'

/** The trigger block id; the head node of every generated graph. */
export const TRIGGER_BLOCK_ID = 'trigger'

/** Origin of a draft, kept on the object so the UI can label its review card. */
export type DraftSource = 'chat-generate' | 'chat-history'

/**
 * A branch the last appended node actually took, consumed by the next append.
 * `output` is a port suffix (`output-1`, `output-2`, `output-fallback`) that
 * gets prefixed with the source node's block id to form the edge handle.
 */
export interface PendingBranch {
  /** Node the edge starts from. */
  source: string
  /** That node's block id, for the `<blockId>-output-N` handle. */
  sourceBlockId: string
  /** Output port suffix on the source node. */
  output: string
}

/**
 * A workflow being assembled by the agent, one operator call at a time.
 *
 * `nodes` is in append order and always starts with the trigger head, so the
 * graph is launchable the moment it is composed. `tail` is the auto-chain
 * anchor; `pendingBranch` overrides it for exactly one append when the last
 * node took a specific output port.
 */
export interface WorkflowDraft {
  conversationId: string
  name: string
  /** Nodes in append order. The head node is always the trigger. */
  nodes: WorkflowNode[]
  /** Edges in append order. Linear chains auto-emit one edge per append. */
  edges: WorkflowEdge[]
  /** Last appended node id; auto-next anchor when the model does not branch. */
  tail: string | null
  /** Where the draft came from; surfaces in the review card header. */
  source: DraftSource
  /** Branch awaiting a target; set by an executed branch node or `next`. */
  pendingBranch?: PendingBranch
  /**
   * The user's request that started this generation, when the UI captured it.
   * Becomes the derived goal spec's summary — the honest statement of intent.
   */
  goalText?: string
  /**
   * Generation-time variable bag.
   *
   * Operators like `set-variable` / `get-secret` / `conditions` read and write
   * variables. The bridge runs them for real, so their values have to survive
   * between tool calls — otherwise a `{{password}}` written into a later
   * `forms` node would have nothing to resolve against. Persisted with the
   * draft so a service-worker restart mid-run does not lose it.
   */
  variables?: Record<string, unknown>
  /**
   * The page the generation session FIRST acted on (full URL of the tab the
   * first element-acting operator ran against).
   *
   * A graph that opens no page of its own (no `new-tab` before its first
   * element action) can only replay on THAT page — the manual trigger drives
   * whatever tab is active. The save card and the run gate read this to tell
   * the user so before the workflow fails on the wrong page.
   */
  originUrl?: string
}
