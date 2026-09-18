/**
 * Selector probing: the data shapes and the pure decisions.
 *
 * Split from `background/selector-probe` (which owns the page injection) so the
 * protocol can be shared with the panel without `lib` depending on
 * `background`, and so the classification can be tested without a browser.
 *
 * @module lib/workflow/selector-probe
 */

import type { Workflow } from './types'

/** How a selector fared against the live page. */
export type SelectorStatus = 'unique' | 'ambiguous' | 'missing'

export interface SelectorProbeResult {
  nodeId: string
  blockId: string
  selector: string
  /** Matches found. `-1` when the selector itself is invalid. */
  matches: number
  status: SelectorStatus
}

/** Cap on selectors probed in one injection — a graph this size is not real. */
const MAX_SELECTORS = 200

/**
 * Classify a match count. One match is the only unambiguously good answer:
 * zero means the step will do nothing, and more than one means the executor
 * may act on the wrong element.
 */
export function statusOf(matches: number): SelectorStatus {
  if (matches === 1) return 'unique'
  if (matches > 1) return 'ambiguous'
  return 'missing'
}

/** The selectors worth probing: non-empty, on a non-trigger node. */
export function selectorsOf(
  workflow: Workflow,
): { nodeId: string; blockId: string; selector: string }[] {
  const found: { nodeId: string; blockId: string; selector: string }[] = []
  for (const node of workflow.drawflow.nodes) {
    const blockId = typeof node.data?.['blockId'] === 'string' ? node.data['blockId'] : ''
    const selector = node.data?.['selector']
    if (!blockId || blockId === 'trigger') continue
    if (typeof selector !== 'string' || !selector.trim()) continue
    found.push({ nodeId: node.id, blockId, selector: selector.trim().slice(0, 300) })
  }
  return found.slice(0, MAX_SELECTORS)
}

/** The probes that need the user's attention before the workflow is saved. */
export function failingProbes(probes: readonly SelectorProbeResult[]): SelectorProbeResult[] {
  return probes.filter((probe) => probe.status !== 'unique')
}
