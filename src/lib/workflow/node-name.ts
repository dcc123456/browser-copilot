/**
 * Node display name — the single resolver for turning a node id into the name a
 * human sees in repair logs, validation errors and proposal views.
 *
 * A node never has a free-form title in this graph, so the name is derived
 * deterministically:
 *
 *   1. a per-node `description` (the user-facing note) prefixed by the block's
 *      display name, e.g. `Get text: read the token`;
 *   2. the block's display name alone when there is no description;
 *   3. the raw id only when the node or block cannot be resolved.
 *
 * Use {@link nodeDisplayNameOf} for a node already in hand and
 * {@link displayNameOfNodeId} when only an id is available.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/node-name
 */

import { BLOCK_BY_ID } from './blocks/palette'
import type { Workflow, WorkflowNode } from './types'

/** Block id of a node: the explicit `blockId` param, else the node's `label`. */
function blockIdOfNode(node: WorkflowNode): string {
  const explicit = node.data?.['blockId']
  return typeof explicit === 'string' && explicit ? explicit : node.label
}

/** Resolve a node to its human-readable display name. */
export function nodeDisplayNameOf(node: WorkflowNode | undefined): string {
  if (!node) return ''
  const blockId = blockIdOfNode(node)
  const name = BLOCK_BY_ID.get(blockId)?.name ?? blockId
  const description =
    typeof node.data?.['description'] === 'string' ? node.data['description'].trim() : ''
  return description ? `${name}: ${description}` : name
}

/** Resolve a node id to its display name within a workflow; falls back to id. */
export function displayNameOfNodeId(workflow: Workflow, nodeId: string): string {
  const node = workflow.drawflow.nodes.find((item) => item.id === nodeId)
  if (!node) return nodeId
  const name = nodeDisplayNameOf(node)
  return name || nodeId
}
