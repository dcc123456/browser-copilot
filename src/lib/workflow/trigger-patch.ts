/**
 * Apply trigger choices to a workflow.
 *
 * The trigger lives in TWO representations: the `trigger` block inside the
 * graph (the real source of truth — the background listeners, validation and
 * `workflowAutoTrigger` all read `node.data`) and the denormalized top-level
 * `workflow.trigger`. Nothing keeps them in sync automatically: `saveWorkflow`
 * does not call `triggerFromNodes`, so a workflow whose trigger block says
 * `interval` but whose top-level field still says `manual` will not be armed.
 *
 * {@link applyTriggerSelection} and {@link withTriggerSpecs} therefore patch
 * BOTH and derive the top-level mirror from the node, in one pure step. A
 * workflow may now carry several triggers (`data.triggers`); the FIRST entry is
 * the primary, and it alone is mirrored onto the legacy flat fields.
 *
 * @module lib/workflow/trigger-patch
 */

import { isTriggerNode, triggerFromNodes } from './migrate'
import type { OfferedTriggerType } from './trigger-options'
import {
  TRIGGER_KIND_FIELDS,
  normalizeTriggers,
  primaryTrigger,
  writeTriggers,
  type WorkflowTriggerSpec,
} from './triggers'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

export { TRIGGER_KIND_FIELDS }

/** A trigger choice made in the save card. */
export interface TriggerSelection {
  type: OfferedTriggerType
  /** Values for the fields {@link TRIGGER_KIND_FIELDS} lists for `type`. */
  params: Record<string, unknown>
}

/** The primary trigger currently stored on a workflow. */
export function triggerSelectionOf(workflow: Workflow): TriggerSelection {
  const node = workflow.drawflow.nodes.find(isTriggerNode)
  const specs = normalizeTriggers(node?.data, workflow.trigger)
  const primary = primaryTrigger(specs)
  const type: OfferedTriggerType =
    typeof primary.type === 'string' && primary.type in TRIGGER_KIND_FIELDS
      ? (primary.type as OfferedTriggerType)
      : 'manual'
  const params: Record<string, unknown> = {}
  for (const field of TRIGGER_KIND_FIELDS[type]) {
    const value = primary.data[field]
    if (value !== undefined) params[field] = value
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
 * Return a copy of `workflow` whose trigger block carries `specs`.
 *
 * Pure: the input workflow is never mutated, so the save card and the trigger
 * modal can re-derive a preview on every click without accumulating edits.
 */
export function withTriggerSpecs(
  workflow: Workflow,
  specs: readonly WorkflowTriggerSpec[],
): Workflow {
  const { nodes, edges, triggerId } = withTriggerNode(
    workflow.drawflow.nodes,
    workflow.drawflow.edges,
  )
  const nextNodes = nodes.map((node) =>
    node.id === triggerId
      ? { ...node, data: { ...writeTriggers(node.data, specs), blockId: 'trigger' } }
      : node,
  )

  return {
    ...workflow,
    drawflow: { ...workflow.drawflow, nodes: nextNodes, edges },
    // Derived from the patched node, so the two representations cannot drift.
    trigger: triggerFromNodes(nextNodes) ?? { type: 'manual', enabled: true },
  }
}

/**
 * Replace the PRIMARY trigger with `sel`, keeping any additional triggers.
 *
 * The other kinds' fields are dropped from the new primary: a leftover `url` on
 * an interval trigger is exactly the sort of thing that makes an editor (or a
 * reader) believe the wrong trigger is configured.
 */
export function applyTriggerSelection(workflow: Workflow, sel: TriggerSelection): Workflow {
  const node = workflow.drawflow.nodes.find(isTriggerNode)
  const specs = normalizeTriggers(node?.data, workflow.trigger)
  const data: Record<string, unknown> = {}
  for (const field of TRIGGER_KIND_FIELDS[sel.type]) {
    const value = sel.params[field]
    if (value !== undefined) data[field] = value
  }
  const next: WorkflowTriggerSpec[] = [
    { ...primaryTrigger(specs), type: sel.type, data },
    ...specs.slice(1),
  ]
  return withTriggerSpecs(workflow, next)
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
