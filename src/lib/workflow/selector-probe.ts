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
import { selectorFromTarget } from './target-to-selector'

/** How a selector fared against the live page. */
export type SelectorStatus = 'unique' | 'ambiguous' | 'missing'

export interface SelectorProbeResult {
  nodeId: string
  blockId: string
  selector: string
  /** Matches found. `-1` when the selector itself is invalid. */
  matches: number
  status: SelectorStatus
  /**
   * Actionability of the unique match (spec C2): `false` when the element is
   * hidden or obscured, `true` when it is visible and clickable. Absent when
   * `matches !== 1` or when actionability could not be determined.
   */
  actionable?: boolean
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
    if (!blockId || blockId === 'trigger') continue
    // A node that recorded a rich target (role/text/ref spec) with no flat
    // selector is still located — probe the CSS form of the target so the
    // save card has live evidence for it too (mirrors `selectorOf`).
    const selector =
      (typeof node.data?.['selector'] === 'string' && node.data['selector']) ||
      selectorFromTarget(node.data?.['target'])
    if (typeof selector !== 'string' || !selector.trim()) continue
    found.push({ nodeId: node.id, blockId, selector: selector.trim().slice(0, 300) })
  }
  return found.slice(0, MAX_SELECTORS)
}

/** The probes that need the user's attention before the workflow is saved. */
export function failingProbes(probes: readonly SelectorProbeResult[]): SelectorProbeResult[] {
  return probes.filter((probe) => probe.status !== 'unique')
}

/**
 * Bilingual `saveWarnings` lines for the two live-locator concerns the static
 * validator cannot catch (spec C2): a selector that matches MANY elements
 * (ambiguous — the step may act on the wrong one), and a selector that matches
 * exactly one element but is hidden/obscured (not actionable — the click/fill
 * will no-op or fail at replay).
 *
 * Missing selectors (zero matches) are layer C's `LOCATOR_MISSING` territory
 * and are surfaced there; this helper only turns the ACTIONABILITY evidence the
 * live probe adds into copy. Pure and chrome-free, so it is unit-testable.
 */
export function locatorConcernLines(probes: readonly SelectorProbeResult[]): string[] {
  const lines: string[] = []
  for (const probe of probes) {
    if (probe.status === 'ambiguous') {
      lines.push(
        `Ambiguous locator: "${probe.selector}" matches ${probe.matches} elements, so the step ` +
          `may act on the wrong one. ` +
          `歧义定位器："${probe.selector}" 匹配了 ${probe.matches} 个元素，该步骤可能作用在错误的元素上。`,
      )
    } else if (probe.status === 'unique' && probe.actionable === false) {
      lines.push(
        `Not actionable: "${probe.selector}" matches one element, but it is hidden or obscured. ` +
          `不可行动："${probe.selector}" 唯一匹配但元素被隐藏或遮挡，点击/输入将失效。`,
      )
    }
  }
  return lines
}
