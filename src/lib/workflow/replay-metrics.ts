/**
 * Replay-success metrics: the number this project is actually about.
 *
 * "Did the workflow the agent generated run on the FIRST try?" is the question
 * every other step of this work serves, and until it is measured every answer
 * to it is a feeling. One record per (workflow, graph revision): the first run
 * of a revision is that revision's exam, and a later success after an AI repair
 * does not erase the fact that the first attempt failed.
 *
 * Records are deliberately small and carry no page content, no variable values
 * and no selectors — enough to answer "how often, and with which failure code",
 * nothing that would belong in a transcript.
 *
 * @module lib/workflow/replay-metrics
 */

import { fileStorageArea } from '../fs-store'
import { isGeneratedStrict } from './reliability'
import { trialFailureCode } from './trial-run'
import { currentRevisionOf } from './workflow-revision'
import type { TrialOutcome } from './trial-run'
import type { Workflow } from './types'

/** How the first replay of a graph revision ended. */
export type FirstRunOutcome = 'ok' | 'failed' | 'cancelled' | 'skipped'

export interface ReplayFirstRunInput {
  workflowId: string
  /** Graph revision the run executed; a repair write-back bumps it. */
  revision: number
  outcome: FirstRunOutcome
  /** The step that ended the run, when the run failed. */
  failedNodeId?: string
  /** Machine-readable failure code (`LOCATOR_NOT_FOUND`, `READINESS_TIMEOUT(…)`). */
  failureCode?: string
  /** How many steps had to fall down the locator ladder to act at all. */
  degradedSteps?: number
  /** Which ladder rungs won, in step order. Rung 4 is a guess, not a match. */
  degradeRungs?: number[]
  /** The run only succeeded because autonomous repair took over. */
  autoRepaired?: boolean
  /** What the pre-save trial said about this graph, when there was one. */
  trialOutcome?: TrialOutcome
  /** Why no trial ran (`no-page`, …) — the honest "we did not look" case. */
  trialSkippedReason?: string
  /** When the run settled. Defaults to now. */
  at?: number
}

export interface ReplayFirstRunRecord extends ReplayFirstRunInput {
  at: number
  degradedSteps: number
  degradeRungs: number[]
  autoRepaired: boolean
}

/** Aggregate view of first-replay outcomes. */
export interface ReplayFirstRunSummary {
  total: number
  ok: number
  /** Clean first passes: ran to the end with no repair and no ladder descent. */
  cleanPasses: number
  failed: number
  byOutcome: Record<FirstRunOutcome, number>
  byFailureCode: Record<string, number>
  /** Records whose worst rung was 4 (the first-visible guess). */
  rung4Records: number
  degradedStepTotal: number
  /** `ok / total`, 0 when nothing was measured. */
  firstRunRate: number
  /** `cleanPasses / total`, 0 when nothing was measured. */
  cleanPassRate: number
}

const KEY = 'bc_replay_first_run_logs'
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const MAX_RECORDS = 2000

const OUTCOMES: readonly FirstRunOutcome[] = ['ok', 'failed', 'cancelled', 'skipped']

function isOutcome(value: unknown): value is FirstRunOutcome {
  return (OUTCOMES as readonly string[]).includes(String(value))
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rungsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((rung): rung is number => typeof rung === 'number' && rung >= 1)
}

/** Reduce untrusted storage content to a valid record, or undefined. */
export function normalizeFirstRunRecord(raw: unknown): ReplayFirstRunRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const workflowId = value['workflowId']
  const revision = numberOf(value['revision'])
  const at = numberOf(value['at'])
  if (typeof workflowId !== 'string' || !workflowId) return undefined
  if (revision === undefined || at === undefined) return undefined
  if (!isOutcome(value['outcome'])) return undefined
  const failedNodeId = value['failedNodeId']
  const failureCode = value['failureCode']
  const trialOutcome = value['trialOutcome']
  const trialSkippedReason = value['trialSkippedReason']
  return {
    workflowId,
    revision,
    at,
    outcome: value['outcome'],
    ...(typeof failedNodeId === 'string' && failedNodeId ? { failedNodeId } : {}),
    ...(typeof failureCode === 'string' && failureCode ? { failureCode } : {}),
    degradedSteps: numberOf(value['degradedSteps']) ?? 0,
    degradeRungs: rungsOf(value['degradeRungs']),
    autoRepaired: value['autoRepaired'] === true,
    ...(isTrialOutcome(trialOutcome) ? { trialOutcome } : {}),
    ...(typeof trialSkippedReason === 'string' && trialSkippedReason
      ? { trialSkippedReason }
      : {}),
  }
}

function isTrialOutcome(value: unknown): value is TrialOutcome {
  return (
    value === 'passed' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'timeout' ||
    value === 'skipped'
  )
}

async function loadRecords(): Promise<ReplayFirstRunRecord[]> {
  const stored = await fileStorageArea().get(KEY)
  const raw = stored[KEY]
  if (!Array.isArray(raw)) return []
  const records: ReplayFirstRunRecord[] = []
  for (const entry of raw) {
    const record = normalizeFirstRunRecord(entry)
    if (record) records.push(record)
  }
  return records
}

/**
 * Record the first replay of one graph revision.
 *
 * Idempotent by (workflowId, revision): a revision gets exactly one exam score,
 * so re-running a workflow that already failed does not quietly improve the
 * statistics, and the caller never has to ask first. Best-effort — metrics must
 * not break a run.
 */
export async function recordReplayFirstRun(
  input: ReplayFirstRunInput,
): Promise<ReplayFirstRunRecord | undefined> {
  try {
    const record = normalizeFirstRunRecord({
      ...input,
      at: input.at ?? Date.now(),
    })
    if (!record) return undefined
    const records = await loadRecords()
    if (
      records.some(
        (existing) =>
          existing.workflowId === record.workflowId && existing.revision === record.revision,
      )
    ) {
      return undefined
    }
    records.push(record)
    const cutoff = Date.now() - MAX_AGE_MS
    const kept = records.filter((entry) => entry.at >= cutoff).slice(-MAX_RECORDS)
    await fileStorageArea().set({ [KEY]: kept })
    return record
  } catch {
    return undefined
  }
}

/**
 * The slice of a finished workflow run this metric needs.
 *
 * Structural on purpose: the engine's result type lives in `background/`, and
 * a metrics module must not depend on it to be readable.
 */
export interface FirstRunEvidence {
  outcome: 'ok' | 'failed' | 'cancelled'
  error?: string
  summary?: string
  trace?: { failedNodeId?: string }
  degradations?: readonly { rung: number }[]
  /** The run only ended well because autonomous repair took over mid-flight. */
  autoRepaired?: boolean
}

/**
 * Grade the first replay of `workflow`'s current revision, then move on.
 *
 * Hand-built graphs are not examined: there is no generation to score, and
 * counting them would dilute the one number this exists for. Fire-and-forget —
 * a measurement that could break a run is not worth having, which is why the
 * callers do not await this and cannot see it fail.
 */
export function observeFirstRunOfRevision(
  workflow: Workflow,
  evidence: FirstRunEvidence,
): void {
  if (!isGeneratedStrict(workflow)) return
  const trial = workflow.settings?.trialRun
  const record = trial && typeof trial === 'object' ? trial : undefined
  const failureCode = trialFailureCode(evidence.error ?? evidence.summary)
  void recordReplayFirstRun({
    workflowId: workflow.id,
    revision: currentRevisionOf(workflow),
    outcome: evidence.outcome,
    ...(evidence.trace?.failedNodeId ? { failedNodeId: evidence.trace.failedNodeId } : {}),
    ...(failureCode ? { failureCode } : {}),
    degradedSteps: evidence.degradations?.length ?? 0,
    degradeRungs: (evidence.degradations ?? []).map((degradation) => degradation.rung),
    autoRepaired: evidence.autoRepaired === true,
    ...(record ? { trialOutcome: record.outcome } : {}),
    ...(record?.outcome === 'skipped' && record.reason
      ? { trialSkippedReason: record.reason }
      : {}),
  }).catch(() => undefined)
}

/**
 * The newest first-run record of a workflow, i.e. what its most recent
 * generation/repair attempt scored. Used by the health card.
 */
export async function latestFirstRunOf(
  workflowId: string,
): Promise<ReplayFirstRunRecord | undefined> {
  const records = await loadRecords()
  return newestPerWorkflow(records).get(workflowId)
}

/**
 * One read for the newest record of every workflow, so a list view can label
 * each card without a storage round trip per card.
 */
export async function latestFirstRuns(): Promise<ReplayFirstRunRecord[]> {
  return [...newestPerWorkflow(await loadRecords()).values()]
}

function newestPerWorkflow(
  records: readonly ReplayFirstRunRecord[],
): Map<string, ReplayFirstRunRecord> {
  const newest = new Map<string, ReplayFirstRunRecord>()
  for (const record of records) {
    const existing = newest.get(record.workflowId)
    if (
      !existing ||
      record.at > existing.at ||
      (record.at === existing.at && record.revision > existing.revision)
    ) {
      newest.set(record.workflowId, record)
    }
  }
  return newest
}

/** Aggregate first-replay outcomes across every measured revision. */
export async function summarizeReplayFirstRuns(): Promise<ReplayFirstRunSummary> {
  return summarizeFirstRunRecords(await loadRecords())
}

/** Pure aggregation, so the numbers are testable without storage. */
export function summarizeFirstRunRecords(
  records: readonly ReplayFirstRunRecord[],
): ReplayFirstRunSummary {
  const byOutcome: Record<FirstRunOutcome, number> = {
    ok: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  }
  const byFailureCode: Record<string, number> = {}
  let cleanPasses = 0
  let rung4Records = 0
  let degradedStepTotal = 0
  for (const record of records) {
    byOutcome[record.outcome] += 1
    degradedStepTotal += record.degradedSteps
    if (record.degradeRungs.some((rung) => rung >= 4)) rung4Records += 1
    if (record.outcome === 'failed' && record.failureCode) {
      byFailureCode[record.failureCode] = (byFailureCode[record.failureCode] ?? 0) + 1
    }
    if (record.outcome === 'ok' && !record.autoRepaired && record.degradeRungs.length === 0) {
      cleanPasses += 1
    }
  }
  const total = records.length
  return {
    total,
    ok: byOutcome.ok,
    cleanPasses,
    failed: byOutcome.failed,
    byOutcome,
    byFailureCode,
    rung4Records,
    degradedStepTotal,
    firstRunRate: total > 0 ? byOutcome.ok / total : 0,
    cleanPassRate: total > 0 ? cleanPasses / total : 0,
  }
}
