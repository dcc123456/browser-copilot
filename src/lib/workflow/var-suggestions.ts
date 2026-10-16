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
import { ENGINE_PROVIDED_NAMES, producedNameOfNode } from './integrity'
import { blockIdOf, fallbackVariableOf, feedsTable } from './producer-completeness'
import { sanitizeName } from './dynamic-data'
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

/** One half-pair of a stored credential: which credential, which field. */
export interface SecretFieldRef {
  credentialId: string
  fieldKey: string
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

/** Separator the `get-secret` block uses to encode a credential reference. */
export const CREDENTIAL_SEPARATOR = '::'

/** `get-secret` stores `<credentialId>::<fieldKey>` in its `credential` param. */
export function credentialRefOf(ref: SecretFieldRef): string {
  return `${ref.credentialId}${CREDENTIAL_SEPARATOR}${ref.fieldKey}`
}

/** Parse a `credential` param back, or `null` when it is not a credential ref. */
export function parseCredentialRef(value: unknown): SecretFieldRef | null {
  if (typeof value !== 'string') return null
  const at = value.indexOf(CREDENTIAL_SEPARATOR)
  if (at <= 0 || at === value.length - CREDENTIAL_SEPARATOR.length) return null
  const credentialId = value.slice(0, at)
  const fieldKey = value.slice(at + CREDENTIAL_SEPARATOR.length)
  return credentialId && fieldKey ? { credentialId, fieldKey } : null
}

/**
 * The variable name given to a freshly created `get-secret` producer.
 *
 * Matches the name the history→workflow conversion already mints
 * (`lib/storage`, `secret_<id>_<field>`) so a secret referenced from the picker
 * and one recorded from a live run look the same downstream. Both halves go
 * through {@link sanitizeName}: a credential id is user-supplied text, and a
 * name containing `.` or braces would silently become a path — or no token at all.
 */
export function secretVariableNameOf(ref: SecretFieldRef): string {
  return `secret_${sanitizeName(ref.credentialId)}_${sanitizeName(ref.fieldKey)}`
}

/** Loop producers and the names the run loop publishes for their body. */
const LOOP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'loop-data': ['loopIndex', 'loopItem'],
  'loop-elements': ['loopIndex', 'loopItem', 'loopElementSelector'],
}

/** Block that writes a credential into a variable, and the param carrying the ref. */
const SECRET_PRODUCER_BLOCK = 'get-secret'

/**
 * Build the suggestion list for one node: only what can genuinely hold a value
 * by the time this node runs.
 *
 * - declared inputs (the trigger's `parameters`), flagged when they are secrets;
 * - every reachable upstream node's `variableName`;
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
    if (seen.has(suggestion.id)) return
    seen.add(suggestion.id)
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
    const name = producedNameOfNode(node)
    if (!name) continue
    push({
      id: `variable:${node.id}:${name}`,
      origin: 'variable',
      name,
      insert: `{{${name}}}`,
      hint: blockIdOf(node),
    })
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
    if (producedNameOfNode(node) === alias) continue
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
  // under that node's real name; one without a producer is still offered, and
  // picking it secures the producer (see `ensureSecretProducer`).
  const producers = new Map<string, string>()
  for (const node of upstream) {
    if (blockIdOf(node) !== SECRET_PRODUCER_BLOCK) continue
    const ref = parseCredentialRef(node.data?.['credential'])
    if (!ref) continue
    const name = producedNameOfNode(node) || secretVariableNameOf(ref)
    producers.set(credentialRefOf(ref), name)
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
  /** True when an existing reachable producer was reused (graph untouched). */
  reused: boolean
  /** The node to add. Present only when one had to be created. */
  added?: WorkflowNode
  /** Full replacement edge list, present only when a node was inserted. */
  edges?: WorkflowEdge[]
  /** Producer found with a blank variable name; patch it so the ref resolves. */
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
 * reference must be fed by something that runs before this node. Otherwise the
 * new node is spliced into the target's normal incoming edge — fallback
 * branches and loop-backs are left alone on purpose, rewiring one would move an
 * error path or a retry rather than the step being edited.
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
  for (const node of graph.nodes) {
    if (!ancestors.has(node.id)) continue
    if (blockIdOf(node) !== SECRET_PRODUCER_BLOCK) continue
    if (parseCredentialRef(node.data?.['credential']) === null) continue
    if (node.data?.['credential'] !== credential) continue
    const named = producedNameOfNode(node)
    if (named) return { variableName: named, reused: true }
    const fallback = secretVariableNameOf(ref)
    return {
      variableName: fallback,
      reused: true,
      nodePatch: { nodeId: node.id, patch: { variableName: fallback } },
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
