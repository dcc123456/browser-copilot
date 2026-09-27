/**
 * The pre-save trial replay: what it may run, and how to describe what it saw.
 *
 * A generated workflow has been proved STEP BY STEP, paced by a model that
 * looked at the page between steps. Nothing proves the graph runs back to back
 * on a replay — and the user is the one who normally discovers that, on their
 * first run. The trial is that discovery, moved to before the save: run the
 * graph for real, once, and write down what happened.
 *
 * The two rules that make this safe to run automatically:
 *
 *   1. **Nothing that cannot be undone is executed.** The trial stops in front
 *      of the first step `idempotencyOf` classifies as unsafe — a submit, a
 *      send, a login. Whatever the trial proves, it never proves it by placing
 *      a second order.
 *   2. **The workflow is saved no matter what the trial says.** A trial is
 *      evidence and a self-heal trigger, never a gate. `compat` mode, a missing
 *      page, a thrown run: all of it lands as a record on `settings.trialRun`
 *      and the save proceeds. A feature that lowered the number of workflows
 *      that get saved would have made the problem worse, not better.
 *
 * Pure module: the path walk and the record reduction are testable without a
 * browser, and the runner that touches the engine lives in
 * `background/workflow-engine/repair/generation-trial.ts`.
 *
 * @module lib/workflow/trial-run
 */

import { idempotencyOf, nodeReliabilityOf } from './reliability'
import type { Workflow, WorkflowNode } from './types'

/** How long a trial may take before it is stopped and recorded as such. */
export const TRIAL_BUDGET_MS = 45_000

export type TrialOutcome =
  /** Every step in the reachable graph ran clean. */
  | 'passed'
  /** The safe prefix ran clean and the trial stopped at its cutoff. */
  | 'partial'
  /** A step failed. The record says which one and with what code. */
  | 'failed'
  /** Stopped by the caller (user cancelled the generation, worker died). */
  | 'cancelled'
  /** The budget ran out. A slow page, not a broken graph. */
  | 'timeout'
  /** The trial did not run, with the reason in `reason`. */
  | 'skipped'

export interface TrialRunRecord {
  outcome: TrialOutcome
  /** When the trial finished, for the health card's "last verified" line. */
  at: number
  durationMs?: number
  runId?: string
  /** True when there was no cutoff — the whole reachable graph was safe to run. */
  full: boolean
  /** Steps proved by the trial, and steps the graph can reach. */
  coveredSteps: number
  totalSteps: number
  /** The step the trial refused to execute because replaying it is not undoable. */
  cutoffNodeId?: string
  failedNodeId?: string
  /** Machine-readable failure prefix (`READINESS_TIMEOUT`, `LOCATOR_NOT_FOUND`, …). */
  failureCode?: string
  /** Steps whose locator had to degrade — the self-heal wrote these back. */
  degradedSteps?: number
  reason?: string
}

/** Raw facts the runner observed from one trial execution. */
export interface TrialRunInput {
  outcome: 'ok' | 'failed' | 'cancelled'
  /** Engine reported it stopped at the cutoff instead of reaching the end. */
  stoppedBefore?: string
  failedNodeId?: string
  error?: string
  completedSteps: number
  degradedSteps?: number
  /** The caller's budget aborted the run. */
  timedOut?: boolean
  cancelledByCaller?: boolean
  durationMs?: number
  runId?: string
  at?: number
}

/** The block id of a node: `data.blockId`, falling back to the label. */
function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/** Trigger-ish blocks that start a run rather than doing work. */
const TRIGGER_BLOCK_IDS = new Set([
  'trigger',
  'manual',
  'schedule',
  'scheduled',
  'visit-web',
  'context-menu',
  'on-startup',
  'keyboard-shortcut',
  'date',
  'specific-day',
  'element-change',
])

/**
 * The chain a run actually walks, in execution order: start at the trigger (or
 * the first node) and follow the FIRST outgoing edge at every step, which is
 * exactly how the engine picks `defaultNext`.
 *
 * A generated graph is a single chain, so this answers the question the trial
 * needs ("what would run, in what order") without a general reachability
 * solver. Branches are simply not part of the prefix the trial proves, and the
 * `visited` guard keeps a hand-wired loop from walking forever.
 */
export function executionPath(workflow: Workflow): WorkflowNode[] {
  const nodes = workflow.drawflow.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const firstOut = new Map<string, string>()
  for (const edge of workflow.drawflow.edges) {
    if (!firstOut.has(edge.source)) firstOut.set(edge.source, edge.target)
  }
  let current: string | null =
    nodes.find((node) => TRIGGER_BLOCK_IDS.has(blockIdOf(node)))?.id ?? nodes[0]?.id ?? null
  const path: WorkflowNode[] = []
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const node = byId.get(current)
    if (!node) break
    if (!TRIGGER_BLOCK_IDS.has(blockIdOf(node))) path.push(node)
    current = firstOut.get(current) ?? null
  }
  return path
}

/**
 * The first step on the execution path that must not be re-fired.
 *
 * Reads come first and are exactly what the trial is for; the cutoff is where
 * "prove it again" turns into "do it again". A graph with no such step returns
 * undefined, and the trial runs the whole thing.
 */
export function trialCutoffNodeId(workflow: Workflow): string | undefined {
  return executionPath(workflow).find((node) => isUnsafeNode(node))?.id
}

/** Does this node's step repeat something the site already committed? */
export function isUnsafeNode(node: WorkflowNode): boolean {
  return idempotencyOf(blockIdOf(node), node.data ?? {}, nodeReliabilityOf(node)) === 'unsafe'
}

/**
 * Is there anything worth running before the cutoff?
 *
 * When the graph's FIRST action is the unsafe one, the trial would run zero
 * steps of the actual workflow — it would only open a tab and stop. Skipping is
 * the honest report there; running would spend 45 seconds proving a step the
 * generation session already proved (the anchor) and tell the user nothing.
 */
export function trialHasNothingToProve(workflow: Workflow): boolean {
  const cutoff = trialCutoffNodeId(workflow)
  if (!cutoff) return false
  return executionPath(workflow)[0]?.id === cutoff
}

/** The engine's failure prefix, when the message carries one. */
export function trialFailureCode(error?: string): string | undefined {
  if (!error) return undefined
  const match = /^([A-Z][A-Z_]{2,})(?:\(([^)]*)\))?/.exec(error.trim())
  if (!match) return undefined
  return match[2] ? `${match[1]}(${match[2]})` : match[1]
}

/**
 * Reduce one trial execution to the record that goes on the workflow.
 *
 * `cutoffNodeId` is passed in rather than re-derived so the caller's view of
 * the graph (the one it actually executed) is what gets recorded.
 */
export function trialRecordOf(
  input: TrialRunInput,
  graph: { cutoffNodeId?: string; totalSteps: number },
): TrialRunRecord {
  const base: TrialRunRecord = {
    outcome: 'passed',
    at: input.at ?? Date.now(),
    full: graph.cutoffNodeId === undefined,
    coveredSteps: input.completedSteps,
    totalSteps: graph.totalSteps,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(graph.cutoffNodeId ? { cutoffNodeId: graph.cutoffNodeId } : {}),
    ...(input.degradedSteps ? { degradedSteps: input.degradedSteps } : {}),
  }
  if (input.timedOut) {
    return { ...base, outcome: 'timeout', reason: 'trial budget exhausted' }
  }
  if (input.cancelledByCaller || input.outcome === 'cancelled') {
    return { ...base, outcome: 'cancelled', reason: 'trial cancelled' }
  }
  if (input.outcome === 'failed') {
    const code = trialFailureCode(input.error)
    return {
      ...base,
      outcome: 'failed',
      ...(input.failedNodeId ? { failedNodeId: input.failedNodeId } : {}),
      ...(code ? { failureCode: code } : {}),
      ...(input.error ? { reason: input.error.slice(0, 300) } : {}),
    }
  }
  // 'ok': a full run is a pass; stopping at the cutoff proves only the prefix.
  return { ...base, outcome: input.stoppedBefore ? 'partial' : 'passed' }
}

/** A trial that never ran, with why. */
export function skippedTrialRecord(reason: string, at = Date.now()): TrialRunRecord {
  return { outcome: 'skipped', at, full: false, coveredSteps: 0, totalSteps: 0, reason }
}

const TRIAL_OUTCOMES: readonly TrialOutcome[] = [
  'passed',
  'partial',
  'failed',
  'cancelled',
  'timeout',
  'skipped',
]

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Rebuild a trial record from stored data, field by field.
 *
 * The record is what the health card reads to decide between "verified" and
 * "unverified", so a stored value that cannot be understood is dropped rather
 * than trusted: an unknown `outcome`, or a missing timestamp, means no record
 * at all (same rule as the settings whitelist in `storage.ts`). Optional
 * numbers keep their own guard so a half-written record cannot claim a step
 * count it did not earn.
 */
export function normalizeTrialRun(raw: unknown): TrialRunRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const outcome = TRIAL_OUTCOMES.find((candidate) => candidate === value.outcome)
  const at = optionalCount(value.at)
  if (!outcome || at === undefined) return undefined
  const durationMs = optionalCount(value.durationMs)
  const coveredSteps = optionalCount(value.coveredSteps)
  const totalSteps = optionalCount(value.totalSteps)
  const degradedSteps = optionalCount(value.degradedSteps)
  const runId = optionalString(value.runId)
  const cutoffNodeId = optionalString(value.cutoffNodeId)
  const failedNodeId = optionalString(value.failedNodeId)
  const failureCode = optionalString(value.failureCode)
  const reason = optionalString(value.reason)
  return {
    outcome,
    at,
    full: value.full === true,
    coveredSteps: coveredSteps ?? 0,
    totalSteps: totalSteps ?? 0,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(cutoffNodeId !== undefined ? { cutoffNodeId } : {}),
    ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(degradedSteps !== undefined ? { degradedSteps } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

/**
 * Does the record prove anything about this workflow?
 *
 * Only a clean run of the whole graph does. `partial` is weaker evidence (the
 * steps after the cutoff are still unproven), and `skipped` / `timeout` /
 * `cancelled` are silence — none of them may be presented to the user as
 * "verified", and none of them may be used to certify a goal.
 */
export function trialCertifies(record: TrialRunRecord | undefined): boolean {
  return record?.outcome === 'passed'
}

/** Does the record say the graph is broken, as opposed to unproven? */
export function trialFailed(record: TrialRunRecord | undefined): boolean {
  return record?.outcome === 'failed'
}
