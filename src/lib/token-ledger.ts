/**
 * Token accounting model — the single source of truth for "where did the
 * tokens go".
 *
 * Two facts shape this module (see
 * `specs/2026-10-12-token-usage-dashboard-design.md` §3):
 *
 * - Nothing upstream persisted usage: only the chat agent turn ever read
 *   `streamCompletion`'s usage, and every other LLM call site threw it away.
 *   So the ledger is built here from the request level up, not derived from
 *   any existing record.
 * - The chat turn's usage is CUMULATIVE across tool rounds
 *   (`background/agent.ts` folds each round's `onUsage` into `totalUsage` and
 *   republishes the running total). Persisting that snapshot would multiply
 *   the same tokens on every round. The unit of the ledger is therefore
 *   exactly one LLM request — the per-round usage delivered by `onUsage`.
 *
 * Everything here is pure and chrome-free so the side panel, the service
 * worker and the headless runner share one set of aggregation rules (AGENTS.md
 * §5.7): ranges, bucketing and grouping are the parts most likely to lie to a
 * user, so they must be unit-testable without a browser.
 *
 * Stored shapes are never trusted: `coerceTokenRecord` / `coerceDailyStore`
 * validate whatever comes back from disk, matching `lib/storage.ts`.
 *
 * @module lib/token-ledger
 */

import type { TokenUsage } from './llm'

/**
 * Which feature paid for a request. Kept fine-grained (a single `chat` bucket
 * would hide context compaction inside the conversation that triggered it) —
 * the dashboard groups by this key.
 */
export type TokenConsumer =
  | 'chat'
  | 'workflow-generation'
  | 'workflow-run'
  | 'ai-debug'
  | 'auto-repair'
  | 'scheduled-task'
  | 'context-compaction'
  | 'vision'
  | 'external-api'

/**
 * Carried on every model request so the host can attribute the usage without
 * the transport layer knowing anything about storage. The entity is a
 * `<kind>:<id>` pair — see {@link entityKeyFor} — because the dashboard has to
 * answer "which conversation / which task / which workflow spent this".
 */
export interface TokenAttribution {
  consumer: TokenConsumer
  entityKey: string
  /** Name at request time; the ledger stores the snapshot (see module header). */
  entityLabel?: string
}

/** Entity kinds the ledger recognises in an `entityKey` prefix. */
export type TokenEntityKind = 'chat' | 'task' | 'workflow' | 'run' | 'session' | 'external'

/** Builds the `<kind>:<id>` attribution key. */
export function entityKeyFor(kind: TokenEntityKind, id: string): string {
  const trimmed = id.trim()
  return `${kind}:${trimmed || 'unknown'}`
}

/** Order the dashboard lists consumers in; also the validation set. */
export const TOKEN_CONSUMERS: readonly TokenConsumer[] = [
  'chat',
  'workflow-generation',
  'workflow-run',
  'ai-debug',
  'auto-repair',
  'scheduled-task',
  'context-compaction',
  'vision',
  'external-api',
]

/** Token counts of one LLM request, plus the request count folded into a tally. */
export interface TokenUsageRecord {
  id: string
  /** Epoch ms of the request completion. */
  at: number
  consumer: TokenConsumer
  /**
   * What to attribute the request to: `chat:<conversationId>`,
   * `task:<taskId>`, `workflow:<workflowId>`, `run:<runId>`, `external:<id>`.
   */
  entityKey: string
  /**
   * The entity's name AT RECORD TIME. Deliberately a snapshot rather than a
   * join at read time: conversations and tasks get deleted, and their past
   * spend must stay readable and recognisable afterwards.
   */
  entityLabel: string
  model: string
  providerId?: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/** Sum of any number of records. `requests` is how many went into it. */
export interface TokenTally {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
  requests: number
}

/** Statistical window the dashboard is showing. */
export type TokenRange = 'today' | '7d' | '30d' | 'all'

/** The windows, in dashboard order; also the validation set for `?range=`. */
export const TOKEN_RANGES: readonly TokenRange[] = ['today', '7d', '30d', 'all']

/** Narrows untrusted input (a query string) to a window. */
export function isTokenRange(value: unknown): value is TokenRange {
  return typeof value === 'string' && (TOKEN_RANGES as readonly string[]).includes(value)
}

/** Resolution of a chart series. */
export type TokenBucketUnit = 'hour' | 'day' | 'week' | 'month'

/** One point of the chart series: a labelled bucket of tokens. */
export interface TokenSeriesPoint {
  /** Stable key within the unit (`'2026-10-12'`, `'2026-10-12/14'`, …). */
  bucketKey: string
  /** Start of the bucket, epoch ms. */
  at: number
  totals: TokenTally
}

/** A consumer or entity row of the breakdown tables. */
export interface TokenGroupRow {
  key: string
  /** Display name: consumer id, or the entity label snapshot. */
  label: string
  totals: TokenTally
  /** Epoch ms of the newest record in the group. */
  lastUsedAt: number
}

/**
 * Per-day accumulation of consumers and entities. This is the durable half of
 * the ledger: the detail array is capped, so without a day-level rollup the
 * "since first use" range would silently degrade into "since the cap".
 */
export interface TokenDailyEntity extends TokenTally {
  label: string
}

export interface TokenDailyDay {
  totals: TokenTally
  byConsumer: Partial<Record<TokenConsumer, TokenTally>>
  byEntity: Record<string, TokenDailyEntity>
}

/** dayKey (`YYYY-MM-DD`, local) → that day's rollup. */
export type TokenDailyStore = Record<string, TokenDailyDay>

/** Detail records kept per install; oldest are dropped first. */
export const MAX_TOKEN_RECORDS = 2000

/**
 * Entity rows kept within one day before the smallest start folding into
 * {@link OTHER_ENTITY_KEY}. Bounds the rollup's size: conversations churn
 * without limit, and an unbounded per-day map would eventually be rewritten on
 * every single request.
 */
export const MAX_DAILY_ENTITIES = 40

/** Bucket an entity group collapses into once {@link MAX_DAILY_ENTITIES} is hit. */
export const OTHER_ENTITY_KEY = '__other__'

/** Rows the dashboard shows per group before folding the tail into one row. */
export const MAX_GROUP_ROWS = 25

/** A range's window in epoch ms, plus the chart resolution for it. */
export interface TokenWindow {
  range: TokenRange
  /** Inclusive start. */
  from: number
  /** Exclusive end. */
  to: number
  unit: TokenBucketUnit
}

/** Everything the dashboard renders, computed in the worker in one pass. */
export interface TokenDashboard {
  range: TokenRange
  window: TokenWindow
  totals: TokenTally
  series: TokenSeriesPoint[]
  byConsumer: TokenGroupRow[]
  byEntity: TokenGroupRow[]
  /** Epoch ms of the oldest record still in the ledger; the honest "since". */
  firstRecordedAt: number | null
  /** True when the per-group tail was folded into an `其他` row. */
  entityTruncated: boolean
  /** Days the rollup covers, oldest first — drives the `all` range start. */
  dayKeys: string[]
}

/** Tally with every field at zero. */
export function emptyTally(): TokenTally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  }
}

/** Adds one record's counts into `target` in place and returns it. */
export function addRecordToTally(target: TokenTally, record: TokenUsageRecord): TokenTally {
  target.inputTokens += record.inputTokens
  target.outputTokens += record.outputTokens
  target.cachedInputTokens += record.cachedInputTokens
  target.reasoningTokens += record.reasoningTokens
  target.totalTokens += record.totalTokens
  target.requests += 1
  return target
}

/** Sum of a list of tallies — used to merge the `other` buckets. */
export function sumTallies(tallies: readonly TokenTally[]): TokenTally {
  const total = emptyTally()
  for (const tally of tallies) {
    total.inputTokens += tally.inputTokens
    total.outputTokens += tally.outputTokens
    total.cachedInputTokens += tally.cachedInputTokens
    total.reasoningTokens += tally.reasoningTokens
    total.totalTokens += tally.totalTokens
    total.requests += tally.requests
  }
  return total
}

/** A finite, non-negative integer, or `fallback`. Storage values are not trusted. */
function nonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/**
 * Builds the record for one completed request.
 *
 * `usage` is the per-request figure from `onUsage` (never a cumulative turn
 * snapshot — see the module header). A provider that omits `total_tokens` gets
 * input + output, matching `SseAccumulator.extractUsage`.
 */
export function recordOf(
  usage: TokenUsage,
  attribution: {
    id: string
    at: number
    consumer: TokenConsumer
    entityKey: string
    entityLabel: string
    model: string
    providerId?: string
  },
): TokenUsageRecord {
  const inputTokens = nonNegativeInt(usage.inputTokens)
  const outputTokens = nonNegativeInt(usage.outputTokens)
  const cachedInputTokens = nonNegativeInt(usage.cachedInputTokens)
  const reasoningTokens = nonNegativeInt(usage.reasoningTokens)
  const reportedTotal = nonNegativeInt(usage.totalTokens)
  return {
    id: attribution.id,
    at: attribution.at,
    consumer: attribution.consumer,
    entityKey: attribution.entityKey,
    entityLabel: attribution.entityLabel,
    model: attribution.model,
    ...(attribution.providerId ? { providerId: attribution.providerId } : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
  }
}

/** Validates one stored record; `null` when the value is unusable junk. */
export function coerceTokenRecord(value: unknown): TokenUsageRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw['id'] !== 'string' || !raw['id']) return null
  if (typeof raw['at'] !== 'number' || !Number.isFinite(raw['at'])) return null
  if (
    typeof raw['consumer'] !== 'string' ||
    !TOKEN_CONSUMERS.includes(raw['consumer'] as TokenConsumer)
  ) {
    return null
  }
  if (typeof raw['entityKey'] !== 'string' || !raw['entityKey']) return null
  const inputTokens = nonNegativeInt(raw['inputTokens'])
  const outputTokens = nonNegativeInt(raw['outputTokens'])
  const reportedTotal = nonNegativeInt(raw['totalTokens'])
  return {
    id: raw['id'],
    at: raw['at'],
    consumer: raw['consumer'] as TokenConsumer,
    entityKey: raw['entityKey'],
    entityLabel: textOr(raw['entityLabel'], raw['entityKey']),
    model: textOr(raw['model'], 'unknown'),
    ...(typeof raw['providerId'] === 'string' && raw['providerId']
      ? { providerId: raw['providerId'] }
      : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens: nonNegativeInt(raw['cachedInputTokens']),
    reasoningTokens: nonNegativeInt(raw['reasoningTokens']),
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
  }
}

/** Local-timezone `YYYY-MM-DD`. Ranges are calendar days as the user counts them. */
export function dayKeyOf(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local-timezone `YYYY-MM-DD/HH`, the bucket key of the hourly series. */
export function hourKeyOf(at: number): string {
  const date = new Date(at)
  return `${dayKeyOf(at)}/${`${date.getHours()}`.padStart(2, '0')}`
}

/** Local midnight starting the calendar day containing `at`. */
export function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local midnight `days` days before the day containing `at` ( DST-safe ). */
function startOfDayMinus(at: number, days: number): number {
  const date = new Date(startOfDay(at))
  date.setDate(date.getDate() - days)
  return date.getTime()
}

/** Monday-aligned local midnight starting the week containing `at`. */
function startOfWeek(at: number): number {
  const date = new Date(startOfDay(at))
  // getDay(): 0 = Sunday. Shift back to the Monday that opens this week.
  const shift = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - shift)
  return date.getTime()
}

/** Local midnight on the 1st of the month containing `at`. */
function startOfMonth(at: number): number {
  const date = new Date(at)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * The window and chart resolution for a range.
 *
 * Granularity adapts so the curve stays readable: today is hourly (a single
 * daily point would draw a flat line), 7/30 days are daily, and the whole
 * history degrades to weekly/monthly buckets rather than thousands of points.
 */
export function rangeWindow(
  range: TokenRange,
  now: number,
  firstRecordedAt: number | null = null,
): TokenWindow {
  switch (range) {
    case 'today':
      return { range, from: startOfDay(now), to: startOfDay(now) + 86_400_000, unit: 'hour' }
    case '7d':
      return { range, from: startOfDayMinus(now, 6), to: startOfDay(now) + 86_400_000, unit: 'day' }
    case '30d':
      return {
        range,
        from: startOfDayMinus(now, 29),
        to: startOfDay(now) + 86_400_000,
        unit: 'day',
      }
    case 'all': {
      const start = firstRecordedAt === null ? startOfDay(now) : startOfDay(firstRecordedAt)
      const spanDays = Math.max(1, Math.ceil((now - start) / 86_400_000))
      const unit: TokenBucketUnit = spanDays > 366 ? 'month' : spanDays > 62 ? 'week' : 'day'
      return { range, from: start, to: startOfDay(now) + 86_400_000, unit }
    }
  }
}

/** Start time of the bucket containing `at`, for a unit. */
function startOfBucket(at: number, unit: TokenBucketUnit): number {
  switch (unit) {
    case 'hour': {
      const date = new Date(at)
      date.setMinutes(0, 0, 0)
      return date.getTime()
    }
    case 'day':
      return startOfDay(at)
    case 'week':
      return startOfWeek(at)
    case 'month':
      return startOfMonth(at)
  }
}

function bucketKeyAt(start: number, unit: TokenBucketUnit): string {
  return unit === 'hour' ? hourKeyOf(start) : dayKeyOf(start)
}

/**
 * Fills the rollup for one record, in place.
 *
 * Shared by the writer and the rebuild path so the day rollup can never drift
 * from the detail records it summarises.
 */
export function applyRecordToDaily(daily: TokenDailyStore, record: TokenUsageRecord): void {
  const key = dayKeyOf(record.at)
  const day: TokenDailyDay = daily[key] ?? {
    totals: emptyTally(),
    byConsumer: {},
    byEntity: {},
  }
  addRecordToTally(day.totals, record)
  const consumerTally = day.byConsumer[record.consumer] ?? emptyTally()
  addRecordToTally(consumerTally, record)
  day.byConsumer[record.consumer] = consumerTally

  const target = record.entityKey
  const existing = day.byEntity[target]
  if (existing) {
    addRecordToTally(existing, record)
    // Refresh the name: a conversation that was renamed deserves to show its
    // current title rather than the one it had on its first request.
    existing.label = record.entityLabel
  } else {
    const entity: TokenDailyEntity = { label: record.entityLabel, ...emptyTally() }
    addRecordToTally(entity, record)
    day.byEntity[target] = entity
    // The `__other__` bucket itself occupies a slot, so creating it is
    // token-neutral and takes a second pass to bring the count back down.
    while (Object.keys(day.byEntity).length > MAX_DAILY_ENTITIES) collapseSmallestEntity(day)
  }
  daily[key] = day
}

/**
 * Folds the day's least-spent entity into {@link OTHER_ENTITY_KEY}, keeping the
 * per-day rollup bounded. The entity's tokens always stay counted — only the
 * row granularity is lost, and only after 40 distinct entities in one day.
 */
function collapseSmallestEntity(day: TokenDailyDay): void {
  let smallestKey = OTHER_ENTITY_KEY
  let smallestTotal = Number.POSITIVE_INFINITY
  for (const [key, entity] of Object.entries(day.byEntity)) {
    if (key === OTHER_ENTITY_KEY) continue
    if (entity.totalTokens < smallestTotal) {
      smallestTotal = entity.totalTokens
      smallestKey = key
    }
  }
  if (smallestKey === OTHER_ENTITY_KEY) return
  const victim = day.byEntity[smallestKey]!
  delete day.byEntity[smallestKey]
  const other: TokenDailyEntity = day.byEntity[OTHER_ENTITY_KEY] ?? {
    label: OTHER_ENTITY_KEY,
    ...emptyTally(),
  }
  other.inputTokens += victim.inputTokens
  other.outputTokens += victim.outputTokens
  other.cachedInputTokens += victim.cachedInputTokens
  other.reasoningTokens += victim.reasoningTokens
  other.totalTokens += victim.totalTokens
  other.requests += victim.requests
  day.byEntity[OTHER_ENTITY_KEY] = other
}

/** Validates a stored rollup, recomputing each day's totals from its groups. */
export function coerceDailyStore(value: unknown): TokenDailyStore {
  const out: TokenDailyStore = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, rawDay] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY_KEY_RE.test(key) || !rawDay || typeof rawDay !== 'object') continue
    const raw = rawDay as Record<string, unknown>
    const day: TokenDailyDay = { totals: emptyTally(), byConsumer: {}, byEntity: {} }
    // `day.totals` is RECOMPUTED from the consumer groups rather than taken from
    // disk: the two halves of a hand-edited or half-written record must not both
    // get to vote on the reported total.
    if (
      raw['byConsumer'] &&
      typeof raw['byConsumer'] === 'object' &&
      !Array.isArray(raw['byConsumer'])
    ) {
      for (const [consumer, tally] of Object.entries(
        raw['byConsumer'] as Record<string, unknown>,
      )) {
        if (!TOKEN_CONSUMERS.includes(consumer as TokenConsumer)) continue
        const merged = coerceTally(tally)
        day.byConsumer[consumer as TokenConsumer] = merged
        addTallyInto(day.totals, merged)
      }
    }
    if (raw['byEntity'] && typeof raw['byEntity'] === 'object' && !Array.isArray(raw['byEntity'])) {
      for (const [entityKey, rawEntity] of Object.entries(
        raw['byEntity'] as Record<string, unknown>,
      )) {
        const entity = coerceTally(rawEntity)
        const label =
          rawEntity && typeof rawEntity === 'object'
            ? textOr((rawEntity as Record<string, unknown>)['label'], entityKey)
            : entityKey
        day.byEntity[entityKey] = { label, ...entity }
      }
    }
    out[key] = day
  }
  return out
}

/** `YYYY-MM-DD` rollup key. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function coerceTally(value: unknown): TokenTally {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    inputTokens: nonNegativeInt(raw['inputTokens']),
    outputTokens: nonNegativeInt(raw['outputTokens']),
    cachedInputTokens: nonNegativeInt(raw['cachedInputTokens']),
    reasoningTokens: nonNegativeInt(raw['reasoningTokens']),
    totalTokens: nonNegativeInt(raw['totalTokens']),
    requests: nonNegativeInt(raw['requests']),
  }
}

function addTallyInto(target: TokenTally, source: TokenTally): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cachedInputTokens += source.cachedInputTokens
  target.reasoningTokens += source.reasoningTokens
  target.totalTokens += source.totalTokens
  target.requests += source.requests
}

/** Local midnight starting the calendar day a rollup key names. */
function dayStartMs(key: string): number {
  // Keys reach here only after `coerceDailyStore` matched `YYYY-MM-DD`, so the
  // parts are always numeric. Building the Date from parts (not `Date.parse`)
  // is what keeps buckets on the user's calendar rather than UTC's.
  const [year, month, day] = key.split('-')
  return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0).getTime()
}

/** Hourly series from the detail records (only the detail has sub-day resolution). */
export function hourlySeries(
  records: readonly TokenUsageRecord[],
  window: TokenWindow,
): TokenSeriesPoint[] {
  // Emit every hour of the local day so the curve has a stable shape even when
  // the user only chatted at 23:00. Buckets are built by calendar hour
  // (`setHours(i)`) rather than `+3_600_000`, which a DST day breaks.
  const buckets = new Map<string, TokenSeriesPoint>()
  for (let hour = 0; hour < 24; hour += 1) {
    const start = new Date(window.from)
    start.setHours(hour, 0, 0, 0)
    if (start.getTime() >= window.to) break
    const bucketKey = hourKeyOf(start.getTime())
    buckets.set(bucketKey, { bucketKey, at: start.getTime(), totals: emptyTally() })
  }
  for (const record of records) {
    if (record.at < window.from || record.at >= window.to) continue
    const bucket = buckets.get(hourKeyOf(record.at))
    if (bucket) addRecordToTally(bucket.totals, record)
  }
  return [...buckets.values()]
}

/** Day/week/month series from the durable rollup, so `all` is really all. */
export function bucketedDailySeries(
  daily: TokenDailyStore,
  window: TokenWindow,
): TokenSeriesPoint[] {
  const buckets = new Map<number, TokenSeriesPoint>()
  // Seed the empty buckets across the window: a gap in usage must show as a
  // zero on the curve, not as a missing point that stretches the neighbours.
  for (
    let at = startOfBucket(window.from, window.unit);
    at < window.to;
    at = nextBucketStart(at, window.unit)
  ) {
    const start = startOfBucket(at, window.unit)
    const bucketKey = bucketKeyAt(start, window.unit)
    buckets.set(start, { bucketKey, at: start, totals: emptyTally() })
  }
  for (const [key, day] of Object.entries(daily)) {
    if (!windowIncludesDay(window, key)) continue
    const start = startOfBucket(dayStartMs(key), window.unit)
    const bucket = buckets.get(start)
    if (!bucket) continue
    addTallyInto(bucket.totals, day.totals)
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at)
}

/** Whether a rollup day key falls inside `window`. */
function windowIncludesDay(window: TokenWindow, key: string): boolean {
  const at = dayStartMs(key)
  return Number.isFinite(at) && at >= window.from && at < window.to
}

function nextBucketStart(at: number, unit: TokenBucketUnit): number {
  const date = new Date(at)
  switch (unit) {
    case 'hour':
      return at + 3_600_000
    case 'day':
      return at + 86_400_000
    case 'week':
      date.setDate(date.getDate() + 7)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    case 'month':
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
  }
}

/** Rows for a `Record<key, tally>` map, sorted by spend, tail folded. */
function groupRows(
  groups: Map<string, { label: string; totals: TokenTally; lastUsedAt: number }>,
  limit: number,
): { rows: TokenGroupRow[]; truncated: boolean } {
  const sorted = [...groups.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.lastUsedAt - a.lastUsedAt)
  if (sorted.length <= limit) {
    return {
      rows: sorted.map((entry) => ({
        key: entry.key,
        label: entry.label,
        totals: entry.totals,
        lastUsedAt: entry.lastUsedAt,
      })),
      truncated: false,
    }
  }
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const other: TokenGroupRow = {
    // A sentinel key/label: the panel translates it, the ledger stays language-free.
    key: OTHER_ENTITY_KEY,
    label: OTHER_ENTITY_KEY,
    totals: sumTallies(tail.map((entry) => entry.totals)),
    lastUsedAt: Math.max(...tail.map((entry) => entry.lastUsedAt)),
  }
  return {
    rows: [
      ...head.map((entry) => ({
        key: entry.key,
        label: entry.label,
        totals: entry.totals,
        lastUsedAt: entry.lastUsedAt,
      })),
      other,
    ],
    truncated: true,
  }
}

/** Consumer + entity breakdowns over a window, from the durable rollup. */
export function dailyGroupRows(
  daily: TokenDailyStore,
  window: TokenWindow,
): { byConsumer: TokenGroupRow[]; byEntity: TokenGroupRow[]; entityTruncated: boolean } {
  const consumers = new Map<string, { label: string; totals: TokenTally; lastUsedAt: number }>()
  const entities = new Map<string, { label: string; totals: TokenTally; lastUsedAt: number }>()
  for (const [key, day] of Object.entries(daily)) {
    if (!windowIncludesDay(window, key)) continue
    // The rollup is day-granular, so a day inside the window stands for the
    // whole day; its `lastUsedAt` is the last ms of that day.
    const dayEnd = dayStartMs(key) + 86_400_000 - 1
    for (const [consumer, tally] of Object.entries(day.byConsumer)) {
      if (!tally) continue
      const group = consumers.get(consumer) ?? {
        label: consumer,
        totals: emptyTally(),
        lastUsedAt: 0,
      }
      addTallyInto(group.totals, tally)
      group.lastUsedAt = Math.max(group.lastUsedAt, dayEnd)
      consumers.set(consumer, group)
    }
    for (const [entityKey, entity] of Object.entries(day.byEntity)) {
      const group = entities.get(entityKey) ?? {
        label: entity.label,
        totals: emptyTally(),
        lastUsedAt: 0,
      }
      addTallyInto(group.totals, entity)
      group.lastUsedAt = Math.max(group.lastUsedAt, dayEnd)
      entities.set(entityKey, group)
    }
  }
  const entityRows = groupRows(entities, MAX_GROUP_ROWS)
  return {
    byConsumer: groupRows(consumers, TOKEN_CONSUMERS.length).rows,
    byEntity: entityRows.rows,
    entityTruncated: entityRows.truncated,
  }
}

/**
 * The whole dashboard payload, computed once per request from the two halves
 * of the ledger. Hourly buckets need the detail records; everything else comes
 * from the rollup so a truncated detail array cannot shrink the reported totals.
 */
export function buildTokenDashboard(
  records: readonly TokenUsageRecord[],
  daily: TokenDailyStore,
  range: TokenRange,
  now = Date.now(),
): TokenDashboard {
  const dayKeys = Object.keys(daily).sort()
  const firstFromRollup = dayKeys[0] ? dayStartMs(dayKeys[0]) : null
  const firstFromRecords = records.length ? Math.min(...records.map((record) => record.at)) : null
  const firstRecordedAt =
    firstFromRollup !== null && firstFromRecords !== null
      ? Math.min(firstFromRollup, firstFromRecords)
      : (firstFromRollup ?? firstFromRecords)
  const window = rangeWindow(range, now, firstRecordedAt)
  const groups = dailyGroupRows(daily, window)
  const totals = sumTallies(
    Object.entries(daily)
      .filter(([key]) => windowIncludesDay(window, key))
      .map(([, day]) => day.totals),
  )
  return {
    range,
    window,
    totals,
    series:
      window.unit === 'hour' ? hourlySeries(records, window) : bucketedDailySeries(daily, window),
    byConsumer: groups.byConsumer,
    byEntity: groups.byEntity,
    firstRecordedAt,
    entityTruncated: groups.entityTruncated,
    dayKeys,
  }
}

/**
 * A host's ledger halves, read from wherever that host keeps them.
 *
 * The extension persists this pair in its file-backed storage and the Runner in
 * `<dataDir>/token-usage.json`; the shapes are identical on purpose, so the same
 * coercion and the same aggregation serve both (design §4.7).
 */
export interface TokenLedger {
  records: readonly TokenUsageRecord[]
  daily: TokenDailyStore
}
