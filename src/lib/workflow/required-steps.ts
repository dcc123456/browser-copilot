/**
 * Required-step detection for the AI node-review dialog.
 *
 * The user requirement: a workflow saved after AI refine must still be
 * runnable — no uncheck may remove a node the graph needs. A step whose
 * removal would introduce a NEW blocker (a dropped variable producer, an
 * unreachable node, the last executable step, …) is "required": its checkbox
 * is locked on and the toggle is refused.
 *
 * Pure functions over a `Workflow` — no chrome, no page.
 *
 * @module workflow/required-steps
 */

import { validateWorkflowForRun } from './validation'
import { checkWorkflowIntegrity } from './integrity'
import { applyNodeKeepSelection, reviewStepsOf } from './review-patch'
import type { Workflow } from './types'

/** The combined set of blocker markers a graph currently carries. */
function blockerSetOf(workflow: Workflow): Set<string> {
  const run = validateWorkflowForRun(workflow)
  const integrity = checkWorkflowIntegrity(workflow)
  return new Set<string>([
    ...run.errors,
    ...integrity.danglingVars.map(
      (ref) => `dangling:${ref.nodeId}.${ref.param}:${ref.reference}`,
    ),
    ...integrity.orphanNodes.map((id) => `orphan:${id}`),
    ...integrity.unreachable.map((id) => `unreachable:${id}`),
  ])
}

/**
 * Ids of the review steps that MUST stay checked on the refine dialog.
 *
 * A step is required when dropping it (and its satellites) introduces any
 * blocker the current graph does not already have — a later node reading
 * `{{var}}` the step was the sole producer of (a dangling reference), a node
 * left unreachable, or a new run-validation error. Comparison is on the
 * blocker SET, so pre-existing problems on a broken draft do not make every
 * step look required.
 */
export function requiredStepIdsOf(workflow: Workflow): string[] {
  const steps = reviewStepsOf(workflow)
  if (steps.length === 0) return []
  const baseBlockers = blockerSetOf(workflow)
  const required: string[] = []
  for (const step of steps) {
    // Simulate dropping exactly this one step.
    const dropped = applyNodeKeepSelection(workflow, { [step.id]: false })
    const nextBlockers = blockerSetOf(dropped)
    if ([...nextBlockers].some((blocker) => !baseBlockers.has(blocker))) {
      required.push(step.id)
    }
  }
  return required
}
