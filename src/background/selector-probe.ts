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

import type { Workflow, WorkflowNode } from '../lib/workflow/types'
import { selectorsOf, statusOf, type SelectorProbeResult } from '../lib/workflow/selector-probe'
import {
  chooseRecordedSelector,
  selectorCandidatesOf,
  type RecordedLocator,
} from '../lib/workflow/target-to-selector'
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

/**
 * Count matches for a batch of selectors, in ONE injection.
 *
 * Used on the record path (one call per operator tool call, a handful of
 * candidates each) and on the save-time hardening pass (one call per graph,
 * capped). Returns null when the page cannot be probed — the caller must then
 * keep the locator as-is rather than pretend it was verified.
 */
export async function countSelectorMatches(
  selectors: readonly string[],
  opts: { tabId?: number; scope?: ScopeWindow } = {},
): Promise<number[] | null> {
  if (selectors.length === 0) return []
  const tab = await resolveAutomationTab(opts.tabId, opts.scope).catch(() => undefined)
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined
  if (typeof tabId !== 'number') return null
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: countMatchesInPage,
      args: [selectors.slice()],
    })
    const result = injection?.result
    if (!Array.isArray(result)) return null
    return result as number[]
  } catch {
    return null
  }
}

/**
 * Verify one recorded locator against the live page and pick its best
 * selector. Unverifiable (no page, injection refused) keeps the locator
 * untouched — "not verified" must never silently degrade a working locator.
 */
export async function verifyRecordedSelector(
  locator: RecordedLocator | undefined,
  opts: { tabId?: number; scope?: ScopeWindow } = {},
): Promise<RecordedLocator | undefined> {
  if (!locator) return locator
  const candidates = selectorCandidatesOf(locator)
  if (candidates.length === 0) return locator
  const counts = await countSelectorMatches(candidates, opts)
  if (!counts) return locator
  const chosen = chooseRecordedSelector(locator, (selector) => {
    const index = candidates.indexOf(selector)
    return index >= 0 ? (counts[index] ?? 0) : 0
  })
  return { ...locator, selector: chosen.selector, verified: chosen.verified }
}

/** Nodes whose element locator can be hardened: element-taking, non-trigger. */
function hardenableNodes(workflow: Workflow): WorkflowNode[] {
  return workflow.drawflow.nodes.filter((node) => {
    const blockId = node.data?.['blockId']
    if (typeof blockId !== 'string' || blockId === 'trigger') return false
    const target = node.data?.['target']
    return (
      typeof node.data?.['selector'] === 'string' || (target != null && typeof target === 'object')
    )
  })
}

/** Cap on selectors probed across one graph — mirrors `selectorsOf`. */
const MAX_HARDEN_SELECTORS = 200

/**
 * Harden every element locator of a compiled/generated graph against the live
 * page, right before it is saved from the generation card.
 *
 * The record path verifies each locator the moment it is recorded, but the
 * history-compiled fallback and older drafts carry selectors nobody ever
 * probed. This pass runs `chooseRecordedSelector` per node with ONE batched
 * injection and rewrites `data.selector` / stamps `data.selectorVerified`.
 * When the page cannot be probed the graph is returned unchanged; a graph too
 * large for the probe cap keeps its oversized tail untouched.
 */
export async function hardenWorkflowSelectors(
  workflow: Workflow,
  opts: { tabId?: number; scope?: ScopeWindow } = {},
): Promise<Workflow> {
  const nodes = hardenableNodes(workflow)
  if (nodes.length === 0) return workflow

  // Gather every node's candidates up front so the page is asked once.
  const perNode: { node: WorkflowNode; locator: RecordedLocator; candidates: string[] }[] = []
  const all: string[] = []
  for (const node of nodes) {
    if (all.length >= MAX_HARDEN_SELECTORS) break
    const locator: RecordedLocator = {
      selector: typeof node.data?.['selector'] === 'string' ? node.data['selector'] : '',
      ...(node.data?.['target'] !== undefined ? { target: node.data['target'] } : {}),
    }
    const candidates = selectorCandidatesOf(locator)
    if (candidates.length === 0) continue
    for (const candidate of candidates) {
      if (all.length >= MAX_HARDEN_SELECTORS) break
      if (!all.includes(candidate)) all.push(candidate)
    }
    perNode.push({ node, locator, candidates })
  }
  if (perNode.length === 0) return workflow

  const counts = await countSelectorMatches(all, opts)
  if (!counts) return workflow
  const countOf = (selector: string): number => {
    const index = all.indexOf(selector)
    return index >= 0 ? (counts[index] ?? 0) : 0
  }

  for (const { node, locator } of perNode) {
    const chosen = chooseRecordedSelector(locator, countOf)
    const data: Record<string, unknown> = { ...node.data, selector: chosen.selector }
    if (chosen.verified) data['selectorVerified'] = true
    else delete data['selectorVerified']
    node.data = data
  }
  return workflow
}
