/**
 * Semantic locator and target resolver (spec §8 · Commit 05).
 *
 * Produces ONE trustworthy locator for an element-bearing node by combining
 * the existing primitives — semantic fingerprints, candidate scoring and
 * target→selector conversion — with a live probe. It does NOT invent a new
 * scoring table: candidates are ranked with `locator-score` and the recorded
 * locator is built with `target-to-selector`.
 *
 * Resolution order (identity beats position):
 *
 *   1. semantic identity  — role+accessible-name / testid / stable id / name
 *   2. aria / label       — labelled control
 *   3. stable CSS         — non-positional selector
 *   4. text               — exact visible text
 *   5. xpath / positional — LAST resort
 *
 * The probe returns the live match count per selector. A candidate is only
 * accepted as verified when it matches EXACTLY ONE element. When a lower
 * candidate wins (the primary locator missed), `usedFallback` is set and the
 * resolver records which fallback was used in the trace notes.
 *
 * Positional-only locators (nth/index/generated path with no semantic
 * identity) are REJECTED rather than silently trusted — mirroring the
 * generated validator's strict rule.
 *
 * Pure apart from the injected probe: no `chrome`, no DOM.
 *
 * @module lib/workflow/locator-resolver
 */

import {
  chooseRecordedSelector,
  reliabilityLocatorOf,
  resolveRecordedLocator,
  selectorCandidatesOf,
  type RecordedLocator,
} from './target-to-selector'
import { candidateFromSelectorString, scoreCandidate } from './locator-score'
import type { SemanticLocator } from './element-fingerprint'
import type { WorkflowNode } from './types'

/** Live probe over a CSS selector: how many elements it matches. */
export type LocatorProbe = (selector: string) => number | Promise<number>

export type ResolutionStatus =
  | 'RESOLVED_PRIMARY'
  | 'RESOLVED_FALLBACK'
  | 'UNRESOLVED'
  | 'REJECTED_POSITIONAL'

export interface ResolvedTarget {
  status: ResolutionStatus
  /** The selected replayable selector ('' when rejected/unresolved). */
  selector: string
  /** The semantic identity used, when one was available. */
  semantic?: SemanticLocator
  /** True when a fallback candidate was used instead of the primary. */
  usedFallback: boolean
  /** Live match count of the selected selector. */
  matchCount: number
  /** Trace notes documenting what was probed / which fallback was used. */
  notes: string[]
  /** The `__reliability.locator` patch implied by the resolution, if any. */
  reliabilityLocator?: ReturnType<typeof reliabilityLocatorOf>
}

/** Positional-only shapes: no identity, only position. */
const POSITIONAL_ONLY = [
  /^[#a-z0-9_[\]="'~^*:.\s>-]*:nth-(child|of-type)\(/i,
]

/** Whether a raw selector is purely positional (a single nth/index path). */
function isPositionalOnlySelector(selector: string): boolean {
  const trimmed = selector.trim()
  // Anything that is essentially one positional pseudo-class and carries no
  // stable identity is positional-only.
  if (/^:nth-(child|of-type)\(/i.test(trimmed)) return true
  // `div:nth-child(3) > span:nth-child(1)` style paths.
  if (POSITIONAL_ONLY[0]!.test(trimmed) && !/\[data-testid|\[name=|#/.test(trimmed)) {
    return true
  }
  return false
}

async function countOf(probe: LocatorProbe, selector: string): Promise<number> {
  try {
    return await probe(selector)
  } catch {
    return -1
  }
}

/**
 * Resolve the element target for one node against the live page.
 *
 * @param node   the element-bearing workflow node
 * @param probe  live match-count probe
 * @param args   optional snapshot-target cache / inline args context used to
 *                build the recorded locator
 */
export async function resolveWorkflowTarget(
  node: WorkflowNode,
  probe: LocatorProbe,
  args?: { snapshotTargets?: Parameters<typeof resolveRecordedLocator>[1] },
): Promise<ResolvedTarget> {
  const notes: string[] = []
  // Build the recorded locator from the node data (selector/target/...).
  const locator: RecordedLocator = resolveRecordedLocator(
    node.data as Record<string, unknown>,
    args?.snapshotTargets,
  )

  // Reject positional-only locators with no semantic identity outright.
  if (locator.selector && isPositionalOnlySelector(locator.selector) && !locator.semantic) {
    notes.push(`rejected positional-only selector: ${locator.selector}`)
    return {
      status: 'REJECTED_POSITIONAL',
      selector: '',
      usedFallback: false,
      matchCount: 0,
      notes,
    }
  }

  const count = async (selector: string): Promise<number> => countOf(probe, selector)

  // Pre-probe every candidate (highest preference first) so the sync chooser
  // and the fallback detection share the same live counts.
  const candidates = selectorCandidatesOf(locator)
  const probeCounts = new Map<string, number>()
  for (const selector of candidates) {
    probeCounts.set(selector, await count(selector))
  }

  const chosen = chooseRecordedSelector(locator, (selector) => {
    // chooseRecordedSelector expects a sync count; all candidates were probed
    // above and the counts are reused here.
    return probeCounts.get(selector) ?? 0
  })

  const primarySelector = (locator.selector ?? '').trim()
  const finalSelector = chosen.selector
  const matchCount = finalSelector ? probeCounts.get(finalSelector) ?? 0 : 0
  const usedFallback = Boolean(finalSelector) && finalSelector !== primarySelector

  if (!finalSelector || matchCount !== 1) {
    notes.push(
      finalSelector
        ? `candidate matches ${matchCount} (${finalSelector})`
        : 'no candidate matched exactly one element',
    )
    return {
      status: 'UNRESOLVED',
      selector: finalSelector,
      ...(locator.semantic ? { semantic: locator.semantic } : {}),
      usedFallback,
      matchCount,
      notes,
    }
  }

  if (usedFallback) {
    notes.push(`primary missed; resolved via fallback: ${primarySelector} → ${finalSelector}`)
  } else {
    notes.push(`resolved via primary: ${finalSelector}`)
  }

  const verifiedLocator: RecordedLocator = { ...locator, selector: finalSelector, verified: true }
  const reliabilityLocator = reliabilityLocatorOf(verifiedLocator)

  return {
    status: usedFallback ? 'RESOLVED_FALLBACK' : 'RESOLVED_PRIMARY',
    selector: finalSelector,
    ...(locator.semantic ? { semantic: locator.semantic } : {}),
    usedFallback,
    matchCount,
    notes,
    ...(reliabilityLocator ? { reliabilityLocator } : {}),
  }
}

/** Re-exported for callers that want the shape classifier here. */
export { candidateFromSelectorString, scoreCandidate }
