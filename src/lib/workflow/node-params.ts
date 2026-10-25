/**
 * How a stored node names its block and carries its parameters.
 *
 * The run engine and the marketplace dependency scan must read a graph the same
 * way: publishing rewrites the exact field the engine will later resolve, and a
 * disagreement here would ship a bundle whose calls no longer line up.
 *
 * @module lib/workflow/node-params
 */

import type { WorkflowNode } from './types'

/**
 * Newer workflows store the block id under `data.blockId`; legacy nodes only
 * have `label` (once the English block id, later a localized name). Falling back
 * in that order keeps old graphs dispatching and keeps a Chinese label out of
 * the executor registry.
 */
export function nodeBlockId(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/**
 * The editor persists user-entered values under `data.values`; legacy or
 * programmatic graphs store parameters directly on `data`. `values` wins when
 * present so executors keep reading `data['url']` regardless of the layout.
 */
export function nodeParams(node: WorkflowNode): Record<string, unknown> {
  const values = node.data?.['values']
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>
  }
  return node.data ?? {}
}
