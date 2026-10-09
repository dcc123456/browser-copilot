/**
 * Selector-uniqueness gate for AI repair proposals (spec D1).
 *
 * A repair proposal can set a selector that, on the real page, matches zero or
 * many elements. Applying it blindly means the "fix" replays against the wrong
 * (or no) element — a leading cause of repair always failing. This module is
 * the pure decision half of the closed loop: it partitions a proposed patch
 * set into the operations whose selector is proven unique (kept) and the ones
 * that must be re-proposed (rejected), given a live match-count function.
 *
 * The live probe and the re-propose loop live in the background layer
 * (`workflow-engine/repair/proposal-verification`); this module stays import-
 * and unit-test-safe with no `chrome` dependency.
 *
 * @module lib/workflow/repair/selector-uniqueness
 */

import type { WorkflowPatchOperation, WorkflowPatchSet } from './types'

/** A single operation that SETS a selector. */
export interface SelectorSetTarget {
  operationId: string
  nodeId: string
  selector: string
}

/** A proposed selector that failed the uniqueness gate. */
export interface RejectedSelector extends SelectorSetTarget {
  /** Live match count that disqualified it: 0 = dead, >1 = ambiguous. */
  matches: number
}

/**
 * The operations of `patch` that set a selector: `SET_PARAM` / `REPLACE_TARGET`
 * whose path resolves to `selector` and whose `after` is a non-empty string
 * (the canonical flat-selector write). Rich `target` object rewrites are not
 * selector strings and are left to the patch engine's existing validation.
 */
export function selectorSetTargetsOf(patch: WorkflowPatchSet): SelectorSetTarget[] {
  const out: SelectorSetTarget[] = []
  for (const op of patch.operations) {
    if (op.kind !== 'SET_PARAM' && op.kind !== 'REPLACE_TARGET') continue
    const path = op.path ?? ''
    if (path !== 'selector' && !path.endsWith('.selector')) continue
    if (typeof op.after !== 'string' || op.after.trim() === '') continue
    out.push({ operationId: op.operationId, nodeId: op.nodeId, selector: op.after })
  }
  return out
}

/**
 * Partition `patch` by selector uniqueness. `countOf(selector)` returns the
 * live match count, or `null` when the page cannot be probed (no tab, refused
 * injection). A definitive 1 keeps the operation; 0 or >1 rejects it; `null`
 * keeps it — "cannot verify" must not regress a repair that runs offline.
 */
export function filterBySelectorUniqueness(
  patch: WorkflowPatchSet,
  countOf: (selector: string) => number | null,
): { kept: WorkflowPatchSet; rejected: RejectedSelector[] } {
  const targets = selectorSetTargetsOf(patch)
  const targetById = new Map(targets.map((t) => [t.operationId, t]))
  const keptOps: WorkflowPatchOperation[] = []
  const rejected: RejectedSelector[] = []
  for (const op of patch.operations) {
    const target = targetById.get(op.operationId)
    if (target) {
      const count = countOf(target.selector)
      if (count !== null && count !== 1) {
        rejected.push({ ...target, matches: count })
        continue
      }
    }
    keptOps.push(op)
  }
  return { kept: { ...patch, operations: keptOps }, rejected }
}
