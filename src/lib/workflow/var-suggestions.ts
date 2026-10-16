/**
 * Dynamic-variable suggestions for block parameters.
 *
 * The editor's string fields offer a `/` menu of the `{{name}}` references that
 * are actually available at the node being edited: the workflow's declared
 * inputs, what the upstream nodes publish, the engine's own aliases, loop
 * context, and the user's stored credentials. Which names exist is a graph
 * question, not a UI one, so it is answered here in pure code and the editor
 * only renders the result (guidelines §5.7).
 *
 * The credential half never carries a VALUE: a secret reaches a workflow
 * through a `get-secret` block that resolves it at run time, so picking one here
 * resolves (or creates) that producer and returns ITS variable name. The literal
 * never enters the workflow definition — same invariant as {@link ensureSecretProducer}.
 *
 * @module lib/workflow/var-suggestions
 */

import type { WorkflowEdge, WorkflowNode, WorkflowTrigger } from './types'
import { incomingNormalEdges, reverseReachable } from './graph-edges'
import { triggerInputs } from './workflow-inputs'
import { ENGINE_PROVIDED_NAMES } from './integrity'
import {
  blockIdOf,
  fallbackVariableOf,
  feedsTable,
  producedVariableNames,
} from './producer-completeness'
import {
  credentialRefOf,
  secretRequestsOf,
  secretRowsOf,
  secretRowsPatch,
  secretVariableNameOf,
  SECRET_PRODUCER_BLOCK,
  type SecretFieldRef,
  type SecretRow,
} from './secret-params'
import { rankByTerm } from '../slash'

/** Where a suggested name comes from — drives the menu's grouping. */
export type SuggestionOrigin = 'input' | 'variable' | 'alias' | 'loop' | 'secret'

/** One row of the `/` menu. */
export interface VariableSuggestion {
  /** Stable list key. */
  id: string
  origin: SuggestionOrigin
  /** Name shown in the row (without the braces). */
  name: string
  /** Text written into the field, e.g. `{{lastText}}`. */
  insert: string
  /** Producer block id, for the row's secondary label; the UI localizes it. */
  hint?: string
  /** True for a credential row that still needs its `get-secret` producer created. */
  needsProducer?: boolean
  /** Set when picking needs a `get-secret` producer secured first. */
  secret?: SecretFieldRef
}

/** A credential field the user may reference — METADATA ONLY, never a value. */
export interface SecretOption extends SecretFieldRef {
  /** Human credential name, e.g. `GitHub PAT`. */
  label: string
}

/** The graph the picker reads. `nodes`/`edges` are the live canvas in workflow shape. */
export interface SuggestionGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  trigger?: WorkflowTrigger
}

/** Loop producers and the names the run loop publishes for their body. */
const LOOP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'loop-data': ['loopIndex', 'loopItem'],
  'loop-elements': ['loopIndex', 'loopItem', 'loopElementSelector'],
}

/**
 * Build the suggestion list for one node: only what can genuinely hold a value
 * by the time this node runs.
 *
 * - declared inputs (the trigger's `parameters`), flagged when they are secrets;
 * - every reachable upstream node's published names (all of them: a
 *   multi-credential `get-secret` node feeds several references);
 * - engine aliases, but ONLY the ones `integrity`'s whitelist already sanctions —
 *   a name missing there is reported dangling at save time, so offering it would
 *   hand the user a reference the save card rejects;
 * - loop context, when a loop producer is upstream;
 * - the user's credential fields (labels only), attached to an existing producer
 *   when one is already reachable.
 */
export function collectSuggestions(
  graph: SuggestionGraph,
  nodeId: string,
  options: { secrets?: readonly SecretOption[] },
): VariableSuggestion[] {
  const ancestors = reverseReachable(graph.edges, nodeId)
  const upstream = graph.nodes.filter((node) => ancestors.has(node.id))
  const out: VariableSuggestion[] = []
  const seen = new Set<string>()

  const push = (suggestion: VariableSuggestion): void => {
    // Dedupe on what gets WRITTEN, not on the row's own id: a node's explicit
    // variable name and another node's fallback alias can be the same name, and
    // two rows inserting `{{lastText}}` is just noise. Collection order makes
    // the surviving row the more specific one (inputs, then variables, then
    // aliases, then loop context, then credentials).
    if (seen.has(suggestion.insert)) return
    seen.add(suggestion.insert)
    out.push(suggestion)
  }

  for (const param of triggerInputs(graph.trigger)) {
    if (!param.name) continue
    push({
      id: `input:${param.name}`,
      origin: 'input',
      name: param.name,
      insert: `{{${param.name}}}`,
      hint: param.description,
    })
  }

  for (const node of upstream) {
    for (const name of producedVariableNames(node)) {
      push({
        id: `variable:${node.id}:${name}`,
        origin: 'variable',
        name,
        insert: `{{${name}}}`,
        hint: blockIdOf(node),
      })
    }
  }

  if (upstream.length > 0) {
    push({ id: 'alias:refData', origin: 'alias', name: 'refData', insert: '{{refData}}' })
  }
  if (upstream.some(feedsTable)) {
    push({ id: 'alias:dataTable', origin: 'alias', name: 'dataTable', insert: '{{dataTable}}' })
  }
  for (const node of upstream) {
    const alias = fallbackVariableOf(blockIdOf(node))
    if (!alias || !ENGINE_PROVIDED_NAMES.has(alias)) continue
    if (producedVariableNames(node).includes(alias)) continue
    push({
      id: `alias:${node.id}:${alias}`,
      origin: 'alias',
      name: alias,
      insert: `{{${alias}}}`,
      hint: blockIdOf(node),
    })
  }

  for (const node of upstream) {
    const names = LOOP_ALIASES[blockIdOf(node)]
    if (!names) continue
    for (const name of names) {
      push({ id: `loop:${node.id}:${name}`, origin: 'loop', name, insert: `{{${name}}}` })
    }
  }

  // A credential already fetched by a reachable `get-secret` node is offered
  // under that ROW's real name (one node can feed several references); one
  // without a producer is still offered, and picking it secures the producer
  // (see `ensureSecretProducer`).
  const producers = new Map<string, string>()
  for (const node of upstream) {
    if (blockIdOf(node) !== SECRET_PRODUCER_BLOCK) continue
    for (const request of secretRequestsOf(node.data)) {
      // A row that names only the credential cannot be matched to a specific
      // field: its run-time fallback (`password`, then the first field) may well
      // resolve to another field than the one offered here.
      if (!request.fieldKey) continue
      producers.set(credentialRefOf(request), request.variableName || secretVariableNameOf(request))
    }
  }
  for (const secret of options.secrets ?? []) {
    const ref = credentialRefOf(secret)
    const existing = producers.get(ref)
    const name = existing ?? secretVariableNameOf(secret)
    push({
      id: `secret:${ref}`,
      origin: 'secret',
      name: `${secret.label} · ${secret.fieldKey}`,
      insert: `{{${name}}}`,
      needsProducer: existing === undefined,
      secret: { credentialId: secret.credentialId, fieldKey: secret.fieldKey },
    })
  }

  return out
}

/** Rank suggestions against the `/term` the user typed. See `rankByTerm`. */
export function filterSuggestions(
  items: readonly VariableSuggestion[],
  term: string,
): VariableSuggestion[] {
  return rankByTerm(
    items,
    term,
    (item) => item.name,
    (item) => item.origin,
  )
}

/** What securing a secret producer did — the editor applies it and writes the name back. */
export interface SecretProducerPatch {
  /** The variable name to reference; the field text becomes `{{variableName}}`. */
  variableName: string
  /** True when a reachable producer already covers the credential (graph untouched). */
  reused: boolean
  /** The node to add. Present only when one had to be created. */
  added?: WorkflowNode
  /** Full replacement edge list, present only when a node was inserted. */
  edges?: WorkflowEdge[]
  /**
   * An upstream producer was reused and had to change: a row that carried no
   * name got one, or this credential joined the node as an extra row (one node,
   * several credentials — see the multi-credential design record).
   */
  nodePatch?: { nodeId: string; patch: Record<string, unknown> }
  /** A node was added but the target had nothing to splice it into. */
  detached?: boolean
}

/** Canvas box size used to keep an inserted node from landing on another. */
const NODE_WIDTH = 200
const NODE_HEIGHT = 70

function overlaps(x: number, y: number, nodes: readonly WorkflowNode[]): boolean {
  return nodes.some(
    (node) =>
      Math.abs(node.position.x - x) < NODE_WIDTH && Math.abs(node.position.y - y) < NODE_HEIGHT,
  )
}

/**
 * Secure a `get-secret` producer for one credential field, as a pure patch.
 *
 * Reuse wins when a reachable producer already fetches the same
 * `<id>::<field>`; a producer elsewhere in the graph is NOT reused, because a
 * reference must be fed by something that runs before this node. When a
 * reachable producer exists but does not fetch THIS field, the field is added as
 * another row of that node — several credentials, one node — rather than
 * stacking a second node onto the canvas. Otherwise the new node is spliced into
 * the target's normal incoming edge — fallback branches and loop-backs are left
 * alone on purpose, rewiring one would move an error path or a retry rather than
 * the step being edited.
 *
 * Idempotent: after the first pick the new node is immediately upstream, so a
 * second pick of the same credential hits the reuse branch.
 */
export function ensureSecretProducer(
  graph: SuggestionGraph,
  targetNodeId: string,
  ref: SecretFieldRef,
  newId: () => string,
): SecretProducerPatch {
  const credential = credentialRefOf(ref)
  const ancestors = reverseReachable(graph.edges, targetNodeId)
  const fallbackName = secretVariableNameOf(ref)
  let appendable: { node: WorkflowNode; rows: SecretRow[] } | undefined
  for (const node of graph.nodes) {
    if (!ancestors.has(node.id)) continue
    if (blockIdOf(node) !== SECRET_PRODUCER_BLOCK) continue
    const rows = secretRowsOf(node.data)
    if (rows.length === 0) continue
    const match = rows.find((row) => row.credential === credential)
    if (match) {
      if (match.variableName) return { variableName: match.variableName, reused: true }
      // The row is there but unnamed: name it, leaving the other rows alone.
      const named = rows.map((row) =>
        row.credential === credential ? { ...row, variableName: fallbackName } : row,
      )
      return {
        variableName: fallbackName,
        reused: true,
        nodePatch: { nodeId: node.id, patch: secretRowsPatch(named) },
      }
    }
    appendable ??= { node, rows }
  }
  // One node, several credentials: the picked field joins the producer that is
  // already upstream rather than stacking a second node for it.
  if (appendable) {
    const patch = secretRowsPatch([...appendable.rows, { credential, variableName: fallbackName }])
    return {
      variableName: fallbackName,
      reused: true,
      nodePatch: { nodeId: appendable.node.id, patch },
    }
  }

  const target = graph.nodes.find((node) => node.id === targetNodeId)
  const variableName = secretVariableNameOf(ref)
  const added: WorkflowNode = {
    id: newId(),
    label: 'Get secret',
    position: { x: (target?.position.x ?? 0) - 240, y: target?.position.y ?? 0 },
    data: {
      blockId: SECRET_PRODUCER_BLOCK,
      credential,
      variableName,
      description: '',
      disableBlock: false,
    },
  }
  // Walk clear of anything already sitting where the new node would land.
  while (overlaps(added.position.x, added.position.y, graph.nodes)) {
    added.position.y += 90
  }

  const incoming = target ? incomingNormalEdges(graph.edges, targetNodeId) : []
  const targetBlockId = target ? blockIdOf(target) : ''
  const edges: WorkflowEdge[] = graph.edges.map((edge) => {
    const spliced = incoming.some((feed) => feed.id === edge.id)
    if (!spliced) return edge
    return { ...edge, target: added.id, targetHandle: `${SECRET_PRODUCER_BLOCK}-input-1` }
  })
  if (incoming.length > 0 && target) {
    edges.push({
      id: newId(),
      source: added.id,
      sourceHandle: `${SECRET_PRODUCER_BLOCK}-output-1`,
      target: targetNodeId,
      targetHandle: `${targetBlockId}-input-1`,
    })
  }

  return {
    variableName,
    reused: false,
    added,
    edges,
    detached: incoming.length === 0,
  }
}
