/**
 * Local takeover statistics (调试埋点).
 *
 * Every AI-takeover episode is appended here so the panel can show the real
 * success rate and the top failure reasons — the feedback loop that tells us
 * whether the success-rate work actually moved the number. Records are capped
 * (most recent 200, ~30 days) and stored in the same storage area as
 * workflows. Chrome-free storage access via {@link fileStorageArea}.
 *
 * Two stores are kept:
 * - `takeoverStats`: one record per takeover EPISODE (node-level attempt), the
 *   original metric — how often the AI rescued a single failed node;
 * - `debugSessionStats`: one record per debug SESSION (run→fix→verify, plus the
 *   replay/audit escalation) — the metric the user actually cares about
 *   ("does it work WITHOUT AI afterwards?"), with phase-level timing so the
 *   remaining bottleneck can be attributed.
 *
 * @module lib/workflow/takeover-stats
 */
import { fileStorageArea } from '../fs-store'
import type { TakeoverReasonKind } from './ai-takeover'

const KEY_STATS = 'takeoverStats'
const KEY_DEBUG_SESSIONS = 'debugSessionStats'

/** Max records kept locally. */
const MAX_RECORDS = 200
/** Records older than this are pruned. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The stage of a debug session a record belongs to. Used for both episode
 * phase tagging and session phase-timing attribution.
 */
export type DebugPhase = 'takeover' | 'replay' | 'audit' | 'verify' | 'rewrite-verify'

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
  /** Which debug phase this episode belongs to (undefined = legacy/normal run). */
  phase?: DebugPhase
  /** Run→fix→verify round index (1-based) the episode happened in. */
  round?: number
  /** Correlates every record of one debug session. */
  sessionId?: string
  /** Model usage attributable to this episode (best-effort). */
  inputTokens?: number
  outputTokens?: number
  /** Whether the episode's proposed fixes were later verified takeover-free. */
  verified?: boolean
  /** Whether the goal judge confirmed the goal for this episode's run. */
  goalAchieved?: boolean
}

/** One recorded debug SESSION (the unit whose success rate matters). */
export interface DebugSessionStatRecord {
  at: number
  sessionId: string
  workflowId: string
  /** Session ended `ok` (a verified takeover-free pass was produced). */
  ok: boolean
  /** A takeover-free verify run passed. */
  verified: boolean
  /** The goal judge confirmed the goal (false when unavailable). */
  goalAchieved: boolean
  /**
   * Whether the goal judge was available. When false the session falls back
   * to the "no error" standard — recorded so the fallback cannot inflate the
   * headline success rate unnoticed.
   */
  judgeAvailable: boolean
  /** Run→fix→verify rounds executed. */
  rounds: number
  /** Total runs executed (takeover + verify + replay + rewrite-verify). */
  attempts: number
  durationMs: number
  /** Wall-clock ms spent per phase (best-effort; only entered phases appear). */
  phases: Partial<Record<DebugPhase, number>>
  /** First phase that failed to produce a verified pass (failure attribution). */
  failedPhase?: DebugPhase
  /** Dominant failure reason for an unverified session (from its episodes). */
  reasonKind?: TakeoverReasonKind
}

/** Aggregate view for the panel (episodes). */
export interface TakeoverStatsSummary {
  total: number
  completed: number
  /** completed / total, 0..1 (0 when total is 0). */
  successRate: number
  /** Failure counts by classified reason, descending. */
  byReason: { reason: TakeoverReasonKind | 'unclassified'; count: number }[]
  recent: TakeoverStatRecord[]
}

/** Aggregate view for the panel (sessions). */
export interface DebugSessionStatsSummary {
  total: number
  verified: number
  /** verified / total, 0..1 (0 when total is 0). */
  successRate: number
  /** Median session wall-clock, ms (0 when no records). */
  p50DurationMs: number
  /** 90th-percentile session wall-clock, ms (0 when no records). */
  p90DurationMs: number
  /** Failure counts by classified reason over UNVERIFIED sessions, descending. */
  byReason: { reason: TakeoverReasonKind | 'unclassified'; count: number }[]
  /** Failure counts by the phase that failed, descending. */
  byPhase: { phase: DebugPhase | 'unknown'; count: number }[]
  /** Average ms spent per phase across sessions that entered it. */
  avgPhaseMs: Partial<Record<DebugPhase, number>>
  recent: DebugSessionStatRecord[]
}

/** Shape check shared by both stores (guards against corrupt/foreign data). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function loadArray(key: string): Promise<Record<string, unknown>[]> {
  const stored = await fileStorageArea().get(key)
  const raw = stored[key]
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord)
}

async function loadRecords(): Promise<TakeoverStatRecord[]> {
  return (await loadArray(KEY_STATS)).filter(
    (record) =>
      typeof record['at'] === 'number' &&
      typeof record['workflowId'] === 'string' &&
      typeof record['nodeId'] === 'string' &&
      typeof record['completed'] === 'boolean',
  ) as unknown as TakeoverStatRecord[]
}

async function loadSessionRecords(): Promise<DebugSessionStatRecord[]> {
  return (await loadArray(KEY_DEBUG_SESSIONS)).filter(
    (record) =>
      typeof record['at'] === 'number' &&
      typeof record['sessionId'] === 'string' &&
      typeof record['workflowId'] === 'string' &&
      typeof record['verified'] === 'boolean',
  ) as unknown as DebugSessionStatRecord[]
}

/** Prunes by age and cap, then persists. Best-effort — never throws. */
async function persist(key: string, records: { at: number }[]): Promise<void> {
  const cutoff = Date.now() - MAX_AGE_MS
  const kept = records.filter((entry) => entry.at >= cutoff).slice(-MAX_RECORDS)
  await fileStorageArea().set({ [key]: kept })
}

/** Records one takeover episode (best-effort; never throws). */
export async function recordTakeoverStat(record: TakeoverStatRecord): Promise<void> {
  try {
    const records = await loadRecords()
    records.push(record)
    await persist(KEY_STATS, records)
  } catch {
    /* stats are best-effort */
  }
}

/** Records one debug session (best-effort; never throws). */
export async function recordDebugSession(record: DebugSessionStatRecord): Promise<void> {
  try {
    const records = await loadSessionRecords()
    records.push(record)
    await persist(KEY_DEBUG_SESSIONS, records)
  } catch {
    /* stats are best-effort */
  }
}

/** Nearest-rank percentile (0..1) over a numeric list; 0 when empty. */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

/** Aggregates the stored episode records for display. */
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

/**
 * Aggregates the stored session records for display. `successRate` uses the
 * STRICT definition: verified sessions / total (a session counts as verified
 * only when a takeover-free run passed AND — when the judge was available —
 * the goal was achieved).
 */
export async function summarizeDebugSessions(
  workflowId?: string,
): Promise<DebugSessionStatsSummary> {
  const all = await loadSessionRecords()
  const records = workflowId ? all.filter((record) => record.workflowId === workflowId) : all
  const verified = records.filter((record) => record.verified).length

  const byReason = new Map<TakeoverReasonKind | 'unclassified', number>()
  const byPhase = new Map<DebugPhase | 'unknown', number>()
  const phaseTotals = new Map<DebugPhase, { total: number; count: number }>()
  for (const record of records) {
    for (const [phase, ms] of Object.entries(record.phases ?? {})) {
      if (typeof ms !== 'number' || ms <= 0) continue
      const entry = phaseTotals.get(phase as DebugPhase) ?? { total: 0, count: 0 }
      entry.total += ms
      entry.count += 1
      phaseTotals.set(phase as DebugPhase, entry)
    }
    if (record.verified) continue
    const reason = record.reasonKind ?? 'unclassified'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    const phase = record.failedPhase ?? 'unknown'
    byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1)
  }

  const avgPhaseMs: Partial<Record<DebugPhase, number>> = {}
  for (const [phase, entry] of phaseTotals) {
    avgPhaseMs[phase] = Math.round(entry.total / entry.count)
  }

  const durations = records
    .map((record) => record.durationMs)
    .filter((ms): ms is number => typeof ms === 'number')

  return {
    total: records.length,
    verified,
    successRate: records.length > 0 ? verified / records.length : 0,
    p50DurationMs: Math.round(percentile(durations, 0.5)),
    p90DurationMs: Math.round(percentile(durations, 0.9)),
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    byPhase: [...byPhase.entries()]
      .map(([phase, count]) => ({ phase, count }))
      .sort((a, b) => b.count - a.count),
    avgPhaseMs,
    recent: records.slice(-10).reverse(),
  }
}

/** Drops every record (used by tests and a future "clear stats" action). */
export async function clearTakeoverStats(): Promise<void> {
  await fileStorageArea().set({ [KEY_STATS]: [] })
}

/** Drops every session record (used by tests and a future "clear stats" action). */
export async function clearDebugSessionStats(): Promise<void> {
  await fileStorageArea().set({ [KEY_DEBUG_SESSIONS]: [] })
}
