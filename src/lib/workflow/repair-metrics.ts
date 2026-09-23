/**
 * Repair round metrics (spec §14).
 *
 * One {@link RepairRoundLog} per repair round of either entry (GENERATION or
 * DEBUG), persisted via the same file-backed storage area as the takeover /
 * debug-session stats. These records answer — without ever logging a raw
 * variable value — the questions in §14: where it failed, why the failed node
 * is only a symptom (or is itself the root cause), which data dependency proves
 * it, what the AI proposed, whether the patch engine accepted it, where the
 * replay started and whether the independent verification passed.
 *
 * Aggregations let production telemetry distinguish (§1.3):
 *   - first-verify success vs patched-replay success vs rewrite success;
 *   - draft preservation vs structural block.
 *
 * @module lib/workflow/repair-metrics
 */

import { fileStorageArea } from '../fs-store'
import type { VerificationFailureType } from './repair/types'

/** Entry the repair round belongs to. */
export type RepairEntry = 'GENERATION' | 'DEBUG'

/** How the repair round ended. */
export type RepairRoundResult =
  | 'VERIFIED'
  | 'TRANSIENT_RECOVERY'
  | 'FAILED'
  | 'DRAFT'
  | 'CANCELLED'

/** One logged repair round (spec §14 RepairRoundLog). */
export interface RepairRoundLog {
  at: number
  sessionId: string
  round: number
  entry: RepairEntry
  /** Symptom node (where the run failed), when known. */
  failedNodeId?: string
  /** Root-cause node(s) located by the deterministic analyzer. */
  rootCauseNodeIds: string[]
  failureType?: VerificationFailureType
  /** Bounded transient retries attempted before patching. */
  transientRetries: number
  patchSetId?: string
  /** Every node the patch touched. */
  patchedNodeIds: string[]
  replayFromNodeId?: string
  usedCheckpoint: boolean
  usedAiTakeover: boolean
  goalAchieved?: boolean
  result: RepairRoundResult
  durationMs: number
}

const KEY = 'bc_repair_round_logs'
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const MAX_RECORDS = 2000

async function loadLogs(): Promise<RepairRoundLog[]> {
  const stored = await fileStorageArea().get(KEY)
  const raw = stored[KEY]
  if (!Array.isArray(raw)) return []
  return (raw as Record<string, unknown>[]).filter(
    (record) =>
      typeof record['at'] === 'number' &&
      typeof record['sessionId'] === 'string' &&
      typeof record['round'] === 'number',
  ) as unknown as RepairRoundLog[]
}

/** Persist one repair round log. Best-effort — never throws. */
export async function recordRepairRound(log: RepairRoundLog): Promise<void> {
  try {
    const logs = await loadLogs()
    logs.push(log)
    const cutoff = Date.now() - MAX_AGE_MS
    const kept = logs.filter((entry) => entry.at >= cutoff).slice(-MAX_RECORDS)
    await fileStorageArea().set({ [KEY]: kept })
  } catch {
    // Metrics must never break the repair loop.
  }
}

/** Aggregate counts by repair result, across an optional entry filter. */
export async function summarizeRepairRounds(entry?: RepairEntry): Promise<{
  total: number
  byResult: Record<RepairRoundResult, number>
  verified: number
  successRate: number
}> {
  const logs = (await loadLogs()).filter((log) => !entry || log.entry === entry)
  const byResult: Record<RepairRoundResult, number> = {
    VERIFIED: 0,
    TRANSIENT_RECOVERY: 0,
    FAILED: 0,
    DRAFT: 0,
    CANCELLED: 0,
  }
  for (const log of logs) byResult[log.result] += 1
  const verified = byResult.VERIFIED
  return {
    total: logs.length,
    byResult,
    verified,
    successRate: logs.length > 0 ? verified / logs.length : 0,
  }
}
