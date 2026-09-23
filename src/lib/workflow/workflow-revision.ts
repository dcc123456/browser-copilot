/**
 * Workflow revision management (spec §18 · Commit 14).
 *
 * Every formal commit bumps a monotonic {@link Workflow.revision} and appends a
 * {@link WorkflowRevisionMetadata} line. AI repair is just one commit source;
 * manual edits and generation bump the same counter, so there is never a fork
 * in the revision sequence.
 *
 * The base JSON format is unchanged: both fields are optional and old records
 * (revision undefined) are treated as revision 0 by {@link currentRevisionOf}.
 *
 * Pure module: no storage, no DOM.
 *
 * @module lib/workflow/workflow-revision
 */

import type { Workflow, WorkflowRevisionMetadata } from './types'

/** Maximum revision-history entries retained on a workflow (spec: cap 20). */
export const REVISION_HISTORY_LIMIT = 20

/** Inputs describing the commit that should produce the next revision. */
export interface CommitRevisionInput {
  source: WorkflowRevisionMetadata['source']
  at?: number
  repairSessionId?: string
}

/** Current revision, treating a pre-revisioning record (undefined) as 0. */
export function currentRevisionOf(workflow: Pick<Workflow, 'revision'>): number {
  return typeof workflow.revision === 'number' && workflow.revision > 0
    ? Math.floor(workflow.revision)
    : 0
}

/** The newest revision-history entry, or undefined when there is none. */
export function latestRevisionRecord(
  workflow: Pick<Workflow, 'revisionHistory'>,
): WorkflowRevisionMetadata | undefined {
  const history = workflow.revisionHistory
  return history && history.length > 0 ? history[history.length - 1] : undefined
}

/**
 * Append the next revision to the workflow and return the updated fields.
 *
 * The revision number is taken from the workflow (never from the caller), so a
 * concurrent edit that already bumped it cannot be silently overwritten: the
 * caller compares {@link currentRevisionOf} against the proposal's
 * `baseRevision` BEFORE calling this and refuses a mismatch.
 */
export function commitWorkflowRevision(
  workflow: Pick<Workflow, 'revision' | 'revisionHistory'>,
  input: CommitRevisionInput,
): { revision: number; revisionHistory: WorkflowRevisionMetadata[] } {
  const parent = currentRevisionOf(workflow)
  const revision = parent + 1
  const at = input.at ?? Date.now()
  const record: WorkflowRevisionMetadata = {
    revision,
    updatedAt: at,
    source: input.source,
    ...(parent > 0 ? { parentRevision: parent } : {}),
    ...(input.repairSessionId ? { repairSessionId: input.repairSessionId } : {}),
  }
  const history = [...(workflow.revisionHistory ?? []), record]
  const trimmed =
    history.length > REVISION_HISTORY_LIMIT
      ? history.slice(history.length - REVISION_HISTORY_LIMIT)
      : history
  return { revision, revisionHistory: trimmed }
}

/**
 * Whether a repair produced against `baseRevision` may still commit onto the
 * given workflow. A concurrent commit (any source) moves the current revision
 * past the base and the repair is stale and must be re-diagnosed.
 */
export function revisionMatchesBase(
  workflow: Pick<Workflow, 'revision'>,
  baseRevision: number,
): boolean {
  return currentRevisionOf(workflow) === baseRevision
}
