/**
 * Apply a trigger choice to a workflow.
 *
 * The trigger lives in TWO places: the `trigger` block inside the graph (the
 * real source of truth — `effectiveTriggerKind` and `workflowAutoTrigger` both
 * read `node.data`) and the denormalized top-level `workflow.trigger`. Nothing
 * keeps them in sync automatically: `saveWorkflow` does not call
 * `triggerFromNodes`, so a workflow whose trigger block says `interval` but
 * whose top-level field still says `manual` will not be armed.
 *
 * {@link applyTriggerSelection} therefore patches BOTH and derives the
 * top-level mirror from the node, in one pure step.
 *
 * @module lib/workflow/trigger-patch
 */

import { isTriggerNode, triggerFromNodes } from './migrate'
import type { OfferedTriggerType } from './trigger-options'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/**
 * The trigger-block fields each kind owns. Switching kinds CLEARS the others,
 * so a node never carries two kinds' parameters at once — a leftover `url` on
 * an `interval` trigger is exactly the sort of thing that makes an editor (or
 * a future reader) believe the wrong trigger is configured.
 *
 * `time` is shared by the two time-of-day kinds.
 */
export const TRIGGER_KIND_FIELDS: Readonly<Record<OfferedTriggerType, readonly string[]>> = {
  manual: [],
  'on-startup': [],
  'keyboard-shortcut': ['shortcut'],
  'context-menu': ['contextMenuName'],
  'visit-web': ['url'],
  interval: ['interval'],
  'specific-day': ['days', 'time'],
  date: ['date', 'time'],
  // A nested object: the observer's element, URL scope and mutation options all
  // live under it, and the picker writes the whole payload at once.
  'element-change': ['observeElement'],
}

/** A trigger choice made in the save card. */
export interface TriggerSelection {
  type: OfferedTriggerType
  /** Values for the fields {@link TRIGGER_KIND_FIELDS} lists for `type`. */
  params: Record<string, unknown>
}

/** The trigger choice currently stored on a workflow. */
export function triggerSelectionOf(workflow: Workflow): TriggerSelection {
  const node = workflow.drawflow.nodes.find(isTriggerNode)
  const rawType = node?.data?.['type'] ?? workflow.trigger?.type
  const type: OfferedTriggerType =
    typeof rawType === 'string' && rawType in TRIGGER_KIND_FIELDS
      ? (rawType as OfferedTriggerType)
      : 'manual'
  const params: Record<string, unknown> = {}
  for (const field of TRIGGER_KIND_FIELDS[type]) {
    const value = node?.data?.[field]
    if (value !== undefined) params[field] = value
  }
  // `visit-web` and `context-menu` denormalize onto the top-level mirror; read
  // it back when the node did not carry the field, so re-opening the card does
  // not silently reset a trigger the editor configured.
  if (type === 'visit-web' && params['url'] === undefined && workflow.trigger?.urlPattern) {
    params['url'] = workflow.trigger.urlPattern
  }
  if (
    type === 'context-menu' &&
    params['contextMenuName'] === undefined &&
    workflow.trigger?.menuItemId
  ) {
    params['contextMenuName'] = workflow.trigger.menuItemId
  }
  return { type, params }
}

/** A fresh trigger node, wired to whichever node currently has no incoming edge. */
function withTriggerNode(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; triggerId: string } {
  const existing = nodes.find(isTriggerNode)
  if (existing) return { nodes: [...nodes], edges: [...edges], triggerId: existing.id }

  const triggerId = `trigger-${nodes.length}-${Math.random().toString(36).slice(2, 8)}`
  const trigger: WorkflowNode = {
    id: triggerId,
    label: 'trigger',
    position: { x: 0, y: 0 },
    data: { blockId: 'trigger', type: 'manual', enabled: true, description: '' },
  }
  const targets = new Set(edges.map((e) => e.target))
  const head = nodes.find((n) => !targets.has(n.id))
  const nextEdges = [...edges]
  if (head) {
    nextEdges.unshift({
      id: `${triggerId}-to-${head.id}`,
      source: triggerId,
      target: head.id,
      sourceHandle: 'trigger-output-1',
      targetHandle: `${(head.data?.['blockId'] as string) ?? head.label}-input-1`,
    })
  }
  return { nodes: [trigger, ...nodes], edges: nextEdges, triggerId }
}

/**
 * Return a copy of `workflow` whose trigger is `sel`.
 *
 * Pure: the input workflow is never mutated, so the save card can re-derive
 * its preview on every toggle without accumulating edits.
 */
export function applyTriggerSelection(workflow: Workflow, sel: TriggerSelection): Workflow {
  const { nodes, edges, triggerId } = withTriggerNode(
    workflow.drawflow.nodes,
    workflow.drawflow.edges,
  )

  const owned = new Set(Object.values(TRIGGER_KIND_FIELDS).flat())
  const nextNodes = nodes.map((node) => {
    if (node.id !== triggerId) return node
    const data: Record<string, unknown> = { ...node.data, blockId: 'trigger' }
    // Drop every kind's fields, then write back the selected kind's.
    for (const field of owned) delete data[field]
    for (const field of TRIGGER_KIND_FIELDS[sel.type]) {
      const value = sel.params[field]
      if (value !== undefined) data[field] = value
    }
    data['type'] = sel.type
    // `enabled` is deliberately NOT forced: a workflow whose trigger was
    // switched off in the editor must not be silently re-armed just because
    // the user picked a different kind in the save card.
    return { ...node, data }
  })

  return {
    ...workflow,
    drawflow: { ...workflow.drawflow, nodes: nextNodes, edges },
    // Derived from the patched node, so the two representations cannot drift.
    trigger: triggerFromNodes(nextNodes) ?? { type: 'manual', enabled: true },
  }
}

/**
 * Change one declared input's default value, on the trigger node AND the mirror.
 *
 * The save card shows the inputs a generated workflow needs so the user can
 * correct a value the model guessed. Editing has to land on the graph NODE
 * because that is the source of truth the editor reads and `triggerFromNodes`
 * derives the mirror from — patching only the mirror would be undone the next
 * time anything re-derives it.
 *
 * A name that is not declared is left alone rather than appended: this edits an
 * existing input, and silently inventing one would put a value in front of the
 * user they never agreed to.
 */
export function withInputDefault(workflow: Workflow, name: string, value: string): Workflow {
  const nextNodes = workflow.drawflow.nodes.map((node) => {
    if (!isTriggerNode(node)) return node
    const raw = node.data?.['parameters']
    if (!Array.isArray(raw)) return node
    let changed = false
    const parameters = raw.map((item) => {
      if (item === null || typeof item !== 'object') return item
      const record = item as Record<string, unknown>
      if (record['name'] !== name) return item
      changed = true
      return { ...record, defaultValue: value }
    })
    return changed ? { ...node, data: { ...node.data, parameters } } : node
  })

  return {
    ...workflow,
    drawflow: { ...workflow.drawflow, nodes: nextNodes },
    trigger: triggerFromNodes(nextNodes) ?? workflow.trigger,
  }
}
