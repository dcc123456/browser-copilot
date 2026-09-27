/**
 * Propose → live-uniqueness-check → reject → re-propose closed loop (spec D1).
 *
 * The repair agent is a one-shot LLM proposal; nothing re-checks its new
 * selectors against the real page before the patch is applied. A selector that
 * matches zero or many elements passes the (structural) patch validation and
 * lands in the working copy, so the replay fails again. This module closes
 * that gap:
 *
 *   1. propose
 *   2. probe every selector the proposal SETS against the live page
 *   3. keep the unique ones; reject 0/ambiguous ones
 *   4. feed the real candidate elements back into the context and re-propose
 *   5. give up after `maxRounds`, returning the best (uniqueness-cleaned) patch
 *
 * The probe is injected, so the loop is unit-testable with fakes; the real one
 * (`liveSelectorProbe`) goes through the page.
 *
 * @module background/workflow-engine/repair/proposal-verification
 */

import type { RepairContext, WorkflowPatchSet, PageEvidence } from '../../../lib/workflow/repair/types'
import {
  filterBySelectorUniqueness,
  selectorSetTargetsOf,
  type RejectedSelector,
} from '../../../lib/workflow/repair/selector-uniqueness'
import { countSelectorMatches } from '../../selector-probe'
import { inspectPage } from '../page-inspect'

/** The live-page operations the selector-gate needs, injectable for tests. */
export interface SelectorProbe {
  /** Live match count for one selector; `null` when unverifiable. */
  count: (selector: string) => Promise<number | null>
  /** Candidate DOM evidence rows for a selector, to feed the next propose. */
  candidates: (selector: string) => Promise<PageEvidence[]>
}

/** A real, page-backed probe (uses the automation tab / scope the run drives). */
export function liveSelectorProbe(tabId?: number): SelectorProbe {
  return {
    count: async (selector) => {
      const counts = await countSelectorMatches([selector], tabId ? { tabId } : {})
      return counts === null ? null : (counts[0] ?? null)
    },
    candidates: async (selector) => {
      const inspection = await inspectPage(selector, undefined, tabId).catch(() => null)
      if (!inspection) return []
      return inspection.interactive.map((element, index) => ({
        evidenceId: `page-cand-${index}`,
        kind: 'DOM',
        detail: `${element.selector} <${element.tag}>${element.text ? ` "${element.text}"` : ''}`,
      }))
    },
  }
}

/** Outcome of the closed loop. */
export interface VerifiedProposalResult {
  /** The uniqueness-cleaned patch from the last round; null when none. */
  patch: WorkflowPatchSet | null
  /** Rounds spent (≥1 when a proposal existed). */
  rounds: number
  /** Every selector the gate rejected across rounds. */
  rejected: RejectedSelector[]
}

/**
 * Run the closed loop. `context.pageEvidence` is mutated in place when a
 * selector is rejected, so the next `propose` sees the real candidates.
 */
export async function proposeWithSelectorVerification(
  propose: (context: RepairContext) => Promise<WorkflowPatchSet | null>,
  probe: SelectorProbe,
  context: RepairContext,
  maxRounds: number,
): Promise<VerifiedProposalResult> {
  const rejectedAll: RejectedSelector[] = []
  let lastKept: WorkflowPatchSet | null = null
  let rounds = 0
  for (let round = 0; round < maxRounds; round += 1) {
    const proposed = await propose(context)
    if (!proposed) break
    rounds = round + 1

    const counts = new Map<string, number | null>()
    for (const target of selectorSetTargetsOf(proposed)) {
      counts.set(target.selector, await probe.count(target.selector))
    }
    const { kept, rejected } = filterBySelectorUniqueness(
      proposed,
      (selector) => counts.get(selector) ?? null,
    )
    lastKept = kept

    if (rejected.length === 0) break

    for (const item of rejected) {
      rejectedAll.push(item)
      const evidence = await probe.candidates(item.selector)
      for (const row of evidence) {
        if (!context.pageEvidence.some((e) => e.evidenceId === row.evidenceId)) {
          context.pageEvidence.push(row)
        }
      }
    }
  }
  // A patch whose every operation was rejected carries no usable edit — report
  // "no patch" so the caller breaks instead of validating an empty operations list.
  const patch = lastKept && lastKept.operations.length > 0 ? lastKept : null
  return { patch, rounds, rejected: rejectedAll }
}