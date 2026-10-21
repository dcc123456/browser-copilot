/**
 * The re-record boundary of a generated chain.
 *
 * A generated chain is recorded by really operating the page, so every step
 * already happened once. Re-running a step is therefore a question of what
 * that step COMMITTED: reading a page or filling a field can be done twice,
 * but a step that saved a draft or posted a form cannot.
 *
 * The boundary is the last node before the chain's first commit. Everything
 * up to it committed nothing and may be re-executed; the commit itself and
 * everything after it are the ground the site already holds.
 *
 * The commit test is the one the trial uses to decide where to stop
 * (`trialCutoffNodeId`), so the two agree on what "a commit" means — a step
 * this module calls re-runnable is exactly a step the trial was willing to
 * run.
 *
 * @module lib/workflow/rerun-policy
 */

import { intentOf } from './reliability'
import { isDraftSaveNode, isTriggerNode, isUnsafeNode } from './trial-run'
import type { WorkflowNode } from './types'

/** Where a re-run may safely start. */
export interface RerunBoundary {
  /** The last node whose re-execution commits nothing. */
  nodeId: string
  /** Its block id. */
  label: string
  /** What the step was for, when the node says so. */
  intent?: string
  /** The first commit after the boundary — the step a re-run must re-record. */
  firstCommitNodeId?: string
  /** The first commit's block id. */
  firstCommitLabel?: string
}

/**
 * Did this step commit something the site cannot take back?
 *
 * This is the trial's own cutoff test, minus the actuation clause: an unsafe
 * step (by block, by intent prose, or by an explicit idempotency contract) and
 * a draft save both hold ground the site keeps.
 */
function commitsSomething(node: WorkflowNode): boolean {
  return isUnsafeNode(node) || isDraftSaveNode(node)
}

/**
 * The last node a re-run may start from.
 *
 * `nodes` must be in EXECUTION order. A draft's nodes are already in append
 * order, and an assembled workflow keeps that order in `drawflow.nodes`.
 *
 * Returns undefined when nothing may be re-executed: the chain is empty, holds
 * no action, or its FIRST action already commits — there is no step before it
 * whose replay would be safe.
 */
export function safeRerunBoundaryOf(nodes: readonly WorkflowNode[]): RerunBoundary | undefined {
  const actions = nodes.filter((node) => !isTriggerNode(node))
  if (actions.length === 0) return undefined

  const firstCommitIndex = actions.findIndex((node) => commitsSomething(node))
  if (firstCommitIndex === -1) {
    const last = actions.at(-1)
    return last ? boundaryOf(last) : undefined
  }

  const commit = actions[firstCommitIndex]
  if (firstCommitIndex === 0 || !commit) return undefined

  const previous = actions[firstCommitIndex - 1]
  const boundary = previous ? boundaryOf(previous) : undefined
  if (!boundary) return undefined
  return {
    ...boundary,
    firstCommitNodeId: commit.id,
    firstCommitLabel: commit.label,
  }
}

/** The boundary record for one node. */
function boundaryOf(node: WorkflowNode): RerunBoundary | undefined {
  const intent = intentOf(node)
  return {
    nodeId: node.id,
    label: node.label,
    ...(intent ? { intent } : {}),
  }
}
