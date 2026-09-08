/**
 * Local takeover statistics (调试埋点).
 *
 * Every AI-takeover episode is appended here so the panel can show the real
 * success rate and the top failure reasons — the feedback loop that tells us
 * whether the success-rate work actually moved the number. Records are capped
 * (most recent 200, ~30 days) and stored in the same storage area as
 * workflows. Chrome-free storage access via {@link fileStorageArea}.
 *
 * @module lib/workflow/takeover-stats
 */
import { fileStorageArea } from '../fs-store'
import type { TakeoverReasonKind } from './ai-takeover'

const KEY_STATS = 'takeoverStats'

/** Max records kept locally. */
const MAX_RECORDS = 200
/** Records older than this are pruned. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** One recorded takeover episode. */
export interface TakeoverStatRecord {
  at: number
  workflowId: string
  nodeId: string
  blockId?: string
  completed: boolean
  attempts: number
  reasonKind?: TakeoverReasonKind
  durationMs?: number
}

/** Aggregate view for the panel. */
export interface TakeoverStatsSummary {
  total: number
  completed: number
  /** completed / total, 0..1 (0 when total is 0). */
  successRate: number
  /** Failure counts by classified reason, descending. */
  byReason: { reason: TakeoverReasonKind | 'unclassified'; count: number }[]
  recent: TakeoverStatRecord[]
}

async function loadRecords(): Promise<TakeoverStatRecord[]> {
  const stored = await fileStorageArea().get(KEY_STATS)
  const raw = stored[KEY_STATS]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (record): record is TakeoverStatRecord =>
      !!record &&
      typeof record === 'object' &&
      typeof (record as TakeoverStatRecord).at === 'number' &&
      typeof (record as TakeoverStatRecord).workflowId === 'string' &&
      typeof (record as TakeoverStatRecord).nodeId === 'string' &&
      typeof (record as TakeoverStatRecord).completed === 'boolean',
  )
}

/** Records one takeover episode (best-effort; never throws). */
export async function recordTakeoverStat(record: TakeoverStatRecord): Promise<void> {
  try {
    const records = await loadRecords()
    records.push(record)
    const cutoff = Date.now() - MAX_AGE_MS
    const kept = records
      .filter((entry) => entry.at >= cutoff)
      .slice(-MAX_RECORDS)
    await fileStorageArea().set({ [KEY_STATS]: kept })
  } catch {
    /* stats are best-effort */
  }
}

/** Aggregates the stored records for display. */
export async function summarizeTakeoverStats(workflowId?: string): Promise<TakeoverStatsSummary> {
  const all = await loadRecords()
  const records = workflowId ? all.filter((record) => record.workflowId === workflowId) : all
  const completed = records.filter((record) => record.completed).length
  const byReason = new Map<TakeoverReasonKind | 'unclassified', number>()
  for (const record of records) {
    if (record.completed) continue
    const reason = record.reasonKind ?? 'unclassified'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  return {
    total: records.length,
    completed,
    successRate: records.length > 0 ? completed / records.length : 0,
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    recent: records.slice(-10).reverse(),
  }
}

/** Drops every record (used by tests and a future "clear stats" action). */
export async function clearTakeoverStats(): Promise<void> {
  await fileStorageArea().set({ [KEY_STATS]: [] })
}
