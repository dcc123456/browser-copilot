/**
 * Probe a compiled workflow's selectors against the live page.
 *
 * A compiled workflow is only as runnable as its selectors. A graph can be
 * structurally perfect — trigger present, every edge wired, every parameter
 * filled — and still do nothing at replay because the button it clicks is no
 * longer there, or because its selector now matches seven elements and the
 * executor clicks the wrong one.
 *
 * This is the cheap half of "guaranteed runnable": the page is still open right
 * after the conversation that produced the graph, so every selector can be
 * checked before the user saves anything. The other half (actually replaying
 * the workflow) was deliberately excluded — see decision D2 in
 * `specs/2026-09-18-record-then-compile-design.md`.
 *
 * The classification and the shapes live in `lib/workflow/selector-probe` so
 * the panel can import them without depending on the background layer.
 *
 * @module background/selector-probe
 */

import type { Workflow } from '../lib/workflow/types'
import { selectorsOf, statusOf, type SelectorProbeResult } from '../lib/workflow/selector-probe'
import { resolveAutomationTab } from './driver'
import type { ScopeWindow } from './automation-scope'

/**
 * Count matches for each selector, in the page.
 *
 * Self-contained by necessity: `chrome.scripting.executeScript` serialises only
 * the function source, so anything from module scope would be a
 * `ReferenceError` in the page. `pnpm verify:injected` enforces this.
 *
 * @returns one count per selector; `-1` marks an unusable selector.
 */
function countMatchesInPage(selectors: string[]): number[] {
  return selectors.map((selector) => {
    try {
      return document.querySelectorAll(selector).length
    } catch {
      // An invalid selector is as unusable as one matching nothing, but the
      // caller can tell them apart by the negative count.
      return -1
    }
  })
}

/**
 * Probe every selector in the graph against the current page.
 *
 * @returns null when the page cannot be probed at all (no injectable tab,
 * restricted origin, injection failure). Null is deliberately not an empty
 * success: the caller must then say "not verified" rather than imply every
 * selector passed.
 */
export async function probeWorkflowSelectors(
  workflow: Workflow,
  scope?: ScopeWindow,
): Promise<SelectorProbeResult[] | null> {
  const targets = selectorsOf(workflow)
  if (targets.length === 0) return []

  const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined
  if (typeof tabId !== 'number') return null

  let counts: number[]
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: countMatchesInPage,
      args: [targets.map((target) => target.selector)],
    })
    const result = injection?.result
    if (!Array.isArray(result)) return null
    counts = result as number[]
  } catch {
    return null
  }

  if (counts.length !== targets.length) return null
  return targets.map((target, i) => {
    const matches = counts[i] ?? 0
    return { ...target, matches, status: statusOf(matches) }
  })
}
