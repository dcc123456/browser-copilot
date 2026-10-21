/**
 * The rules behind the editor's Ctrl+Z, kept apart from the React wiring so they
 * can be read and tested on their own.
 *
 * Undo is a stack of WHOLE-CANVAS snapshots (design specs/2026-10-21-operator-
 * prepend-ai-optimize-and-editor-undo-design.md §D8): recording the entire graph
 * instead of a per-mutation inverse is what lets a step that re-hung, cut or
 * moved several edges come back exactly as it was — and it is the same shape the
 * workflow file holds, so undo restores what a reload would have shown.
 *
 * The stack is deliberately in memory only: it describes unsaved edits, and a
 * reloaded editor starts from the stored workflow.
 *
 * @module workflow-editor/graph-history
 */
import type { NodeChange } from '@xyflow/react'
import type { WorkflowEdge, WorkflowNode } from '../lib/workflow/types'

/** One undoable canvas step: the graph as it was before the change. */
export interface CanvasSnapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** The picked nodes, so undoing a deletion does not land on an empty selection. */
  selectedIds: string[]
}

/** How far Ctrl+Z walks back. */
export const EDITOR_UNDO_LIMIT = 50

/**
 * Add a snapshot, keeping the stack bounded. Oldest steps fall off: a user who
 * wants to go back further than this has the saved workflow to reload.
 */
export function pushCanvasSnapshot(history: CanvasSnapshot[], snapshot: CanvasSnapshot): void {
  history.push(snapshot)
  if (history.length > EDITOR_UNDO_LIMIT) history.shift()
}

/**
 * Whether a batch of React Flow changes removes something from the canvas. The
 * Delete key takes a picked node or edge this way — it never goes through the
 * editor's own delete handlers — so the history has to open a step here.
 */
export function removesAnything(changes: readonly { type: string }[]): boolean {
  return changes.some((change) => change.type === 'remove')
}

/**
 * One step per DRAG, not one per event: dragging a node emits one position change
 * per animation frame (and, for a box-selection drag, one per node per frame), so
 * the first frame of a drag opens the step and the frame that ends it closes it.
 * The open flag lives with the caller because the batches are not self-describing.
 */
export function nodeDragStep(
  changes: readonly NodeChange[],
  dragStepOpen: boolean,
): { push: boolean; dragStepOpen: boolean } {
  const dragging = changes.some((change) => change.type === 'position' && change.dragging === true)
  if (dragging) return { push: !dragStepOpen, dragStepOpen: true }
  return { push: false, dragStepOpen: false }
}
