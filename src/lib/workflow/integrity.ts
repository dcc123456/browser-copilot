/**
 * Save-time integrity check: does this graph hang together?
 *
 * The user's requirement is blunt — "the saved workflow must be runnable: no
 * node may be lost, no variable may be lost". Selector probing answers half of
 * that (does the step still find its element on the page); this answers the
 * other half, which no amount of page inspection can see:
 *
 *   - **A node that no longer hangs off the chain.** The most common way a
 *     generated graph "loses a step" is not deletion — it is an edge that never
 *     got written, leaving the node floating where the engine will never reach
 *     it. The card shows it, so the user is not surprised at replay time.
 *   - **A `{{variable}}` nothing can produce.** A generated workflow resolves
 *     references against the trigger's declared inputs (see
 *     `seedWorkflowInputs`). A reference to a name that is neither declared nor
 *     produced by any block replays as an empty string — the step runs, types
 *     nothing, and the failure looks like a page problem.
 *
 * Scope, deliberately: the producer search is GRAPH-WIDE, not "upstream only".
 * A static pass cannot judge ordering through branches and loops, and guessing
 * would produce false alarms on graphs that run perfectly well. Flagging a
 * reference that nothing in the whole graph can produce is a claim the pass can
 * actually stand behind; that is the bar for putting a red line on the card.
 *
 * Pure functions over a `Workflow` — no chrome, no page — so the panel can call
 * it on whatever graph it is about to save, and tests can drive it directly.
 *
 * @module lib/workflow/integrity
 */

import { referenceRoot, referencesIn } from './dynamic-data'
import { TRIGGER_BLOCK_ID } from './draft-types'
import type { Workflow, WorkflowNode } from './types'

/** One `{{reference}}` no block in the graph produces and no input declares. */
export interface DanglingReference {
  nodeId: string
  blockId: string
  /** The param whose value carries the reference, e.g. `value` or `selector`. */
  param: string
  /** The reference as written, without braces. */
  reference: string
}

export interface WorkflowIntegrity {
  /**
   * References nothing can resolve. Every entry is a step that will silently
   * run with an empty value.
   */
  danglingVars: DanglingReference[]
  /**
   * Nodes with no incoming edge that are not the trigger head — they exist on
   * the canvas but the engine will never run them.
   */
  orphanNodes: string[]
  /**
   * Nodes the trigger head cannot reach by following edges. A subset of
   * {@link orphanNodes} in practice, but reported separately because a graph
   * can have several entry-less clusters after a bad merge.
   */
  unreachable: string[]
}

/**
 * Names the ENGINE provides rather than any block producing them.
 *
 * Written by the executors as fixed aliases alongside the block's own
 * `variableName` (see `workflow-engine/executors.ts`), or injected by the run
 * loop for loops. They are legitimate producers with no node to point at, so
 * without this list the check would cry wolf on graphs that run fine.
 */
const ENGINE_PROVIDED_NAMES: ReadonlySet<string> = new Set([
  'refData',
  'dataTable',
  'lastText',
  'lastValue',
  'lastExport',
  'lastMappedData',
  'lastResult',
  'lastState',
  'lastAIResponse',
  'loopIndex',
  'loopItem',
  'loopElementSelector',
])

/** Is this the graph's trigger head? */
function isTriggerNode(node: WorkflowNode): boolean {
  return node.data?.['blockId'] === TRIGGER_BLOCK_ID
}

/** The block id of a node, or empty when it carries none. */
function blockIdOf(node: WorkflowNode): string {
  const value = node.data?.['blockId']
  return typeof value === 'string' ? value : ''
}

/**
 * Variable names the graph can produce: every node's `variableName` (its own
 * value, or the catalog default the node carries in `data`) plus the engine's
 * fixed aliases.
 */
function producedNames(workflow: Workflow): Set<string> {
  const names = new Set<string>(ENGINE_PROVIDED_NAMES)
  for (const node of workflow.drawflow.nodes) {
    const declared = node.data?.['variableName']
    if (typeof declared === 'string' && declared.trim()) names.add(declared.trim())
  }
  return names
}

/** Inputs the workflow declares on its trigger — mirrored node and top-level. */
function declaredInputNames(workflow: Workflow): Set<string> {
  const names = new Set<string>()
  const collect = (parameters: unknown): void => {
    if (!Array.isArray(parameters)) return
    for (const parameter of parameters) {
      const name = (parameter as { name?: unknown } | null)?.name
      if (typeof name === 'string' && name.trim()) names.add(name.trim())
    }
  }
  for (const node of workflow.drawflow.nodes) {
    if (isTriggerNode(node)) collect(node.data?.['parameters'])
  }
  collect(workflow.trigger?.parameters)
  return names
}

/** Every string value in a node's data, with the path that reaches it. */
function stringValuesIn(
  value: unknown,
  path: readonly string[] = [],
  out: { param: string; value: string }[] = [],
): { param: string; value: string }[] {
  if (typeof value === 'string') {
    out.push({ param: path.join('.') || 'value', value })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => stringValuesIn(item, [...path, String(index)], out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      stringValuesIn(item, [...path, key], out)
    }
  }
  return out
}

/** Node ids the trigger head can reach by following edges. */
function reachableFrom(workflow: Workflow, startId: string): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of workflow.drawflow.edges) {
    const list = outgoing.get(edge.source)
    if (list) list.push(edge.target)
    else outgoing.set(edge.source, [edge.target])
  }
  const seen = new Set<string>([startId])
  const queue = [startId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/**
 * Check a graph's internal consistency. Never throws: a workflow with no
 * trigger head is reported as fully unreachable rather than as an error, so the
 * card can still be shown.
 */
export function checkWorkflowIntegrity(workflow: Workflow): WorkflowIntegrity {
  const nodes = workflow.drawflow.nodes
  const head = nodes.find(isTriggerNode)
  const produced = producedNames(workflow)
  const declared = declaredInputNames(workflow)
  const reachable = head ? reachableFrom(workflow, head.id) : new Set<string>()

  const danglingVars: DanglingReference[] = []
  for (const node of nodes) {
    // The trigger's own `defaultValue`s legitimately hold the literals captured
    // during generation — including ones that look like references the user
    // typed. Checking them would report the declaration site as the problem.
    if (isTriggerNode(node)) continue
    for (const { param, value } of stringValuesIn(node.data)) {
      for (const reference of referencesIn(value)) {
        const root = referenceRoot(reference)
        if (produced.has(root) || declared.has(root)) continue
        danglingVars.push({ nodeId: node.id, blockId: blockIdOf(node), param, reference })
      }
    }
  }

  const orphanNodes: string[] = []
  const targets = new Set(workflow.drawflow.edges.map((edge) => edge.target))
  for (const node of nodes) {
    if (isTriggerNode(node)) continue
    if (!targets.has(node.id)) orphanNodes.push(node.id)
  }

  const unreachable = nodes
    .filter((node) => !isTriggerNode(node) && !reachable.has(node.id))
    .map((node) => node.id)

  return { danglingVars, orphanNodes, unreachable }
}

/** True when nothing needs to be shown on the save card. */
export function integrityIsClean(integrity: WorkflowIntegrity): boolean {
  return (
    integrity.danglingVars.length === 0 &&
    integrity.orphanNodes.length === 0 &&
    integrity.unreachable.length === 0
  )
}
