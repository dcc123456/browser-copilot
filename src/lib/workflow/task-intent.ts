/**
 * Task intent — the structured understanding of what the user asked for
 * (spec §6.2 · Commit 07).
 *
 * Produced at the start of a generation session from the user's task, the
 * origin URL and any snapshot/selection. It captures the goal, the business
 * inputs that will have to be supplied per run, and the classes of side
 * effects the run may trigger — without ever inventing clarity that isn't
 * there: an ambiguous task with an irreversible action must not be guessed.
 *
 * Pure data module.
 *
 * @module lib/workflow/task-intent
 */

import type { WorkflowGoalSpec } from './reliability'

/** A business value the user will supply per run. */
export interface TaskInputCandidate {
  name: string
  value: string
  secret?: boolean
}

/** Recognized classes of side effects a task may have. */
export type SideEffectClass =
  | 'navigation'
  | 'form-submit'
  | 'purchase'
  | 'payment'
  | 'delete'
  | 'send'
  | 'create'
  | 'external-request'
  | 'download'
  | 'other'

export interface TaskIntent {
  summary: string
  goal?: WorkflowGoalSpec
  inputCandidates: TaskInputCandidate[]
  sideEffects: SideEffectClass[]
  expectedOutcome?: string
}

/** True when the intent is clear enough to proceed on irreversible work. */
export function intentIsActionable(intent: TaskIntent): boolean {
  return Boolean(intent.summary && intent.summary.trim())
}

/** Build a task intent with required arrays defaulted. */
export function makeTaskIntent(
  partial: Partial<TaskIntent> & Pick<TaskIntent, 'summary'>,
): TaskIntent {
  return {
    inputCandidates: partial.inputCandidates ?? [],
    sideEffects: partial.sideEffects ?? [],
    ...partial,
  }
}
