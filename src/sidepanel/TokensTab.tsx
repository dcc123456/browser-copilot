/**
 * Tokens tab: where the extension's model spend is read.
 *
 * Every number here comes from the ledger in `lib/token-ledger` (written by
 * `background/token-accounting`), so this panel never adds up raw records and
 * never re-derives a total on its own. The worker returns one dashboard object
 * per range; switching a range or a view is a re-read, not a recompute.
 *
 * Live refresh is a coalesced re-read: the ledger is written on every model
 * request, so an in-flight turn would otherwise restamp the dashboard dozens of
 * times per second.
 *
 * Visual language: a bench instrument. Recessed rails hold the switches, one
 * glowing readout carries the window total, every figure is monospaced and
 * tabular so digits align, and the breakdown rows show their share of the
 * window as an underlay instead of a sixth column (the panel is ~400px wide).
 *
 * @module sidepanel/TokensTab
 */
import { useCallback, useEffect, useMemo, useState, type PointerEvent } from 'react'
import { sendCommand } from '../lib/messages'
import { smoothAreaPath, smoothLinePath, type ChartPoint } from '../lib/token-chart'
import {
  MAX_GROUP_ROWS,
  OTHER_ENTITY_KEY,
  TOKEN_RANGES,
  type TokenBucketUnit,
  type TokenConsumer,
  type TokenDashboard,
  type TokenGroupRow,
  type TokenRange,
  type TokenSeriesPoint,
} from '../lib/token-ledger'
import type { Messages } from '../lib/i18n'
import { STORAGE_RECONNECTED_EVENT } from '../lib/fs-reconnect'
import { onStoreChanged } from '../lib/store-events'
import { confirmDialog } from '../ui/confirm'
import { useI18n } from './i18n'

const RANGE_LABEL: Record<TokenRange, keyof Messages> = {
  today: 'tokensRangeToday',
  '7d': 'tokensRange7d',
  '30d': 'tokensRange30d',
  all: 'tokensRangeAll',
}

/** Consumer ids are stable wire values; their display names are localized here. */
const CONSUMER_LABEL: Record<TokenConsumer, keyof Messages> = {
  chat: 'tokensConsumerChat',
  'workflow-generation': 'tokensConsumerWorkflowGeneration',
  'workflow-run': 'tokensConsumerWorkflowRun',
  'ai-debug': 'tokensConsumerAiDebug',
  'auto-repair': 'tokensConsumerAutoRepair',
  'scheduled-task': 'tokensConsumerScheduledTask',
  'context-compaction': 'tokensConsumerContextCompaction',
  vision: 'tokensConsumerVision',
  'external-api': 'tokensConsumerExternalApi',
}

/** Chart geometry in SVG user units; the element scales to the panel width. */
const CHART_W = 320
const CHART_H = 120
const CHART_PAD = 8

/** Relaxed so a streaming turn refreshes the view without stampeding it. */
const REFRESH_DEBOUNCE_MS = 500

/** One gradient per panel; the id is fixed because only one chart is mounted. */
const AREA_GRADIENT_ID = 'tokens-area-gradient'

/**
 * Staggered entrance, written out as literal classes because Tailwind only
 * emits utilities it can see in the source. The plates re-animate whenever the
 * tab is opened (an element coming back from `display: none` restarts its
 * animations), so switching to this tab reads as the instrument powering up.
 */
const PLATE_ENTER = [
  'animate-[dialog-pop_280ms_ease-out_both]',
  'animate-[dialog-pop_280ms_ease-out_both] [animation-delay:70ms]',
  'animate-[dialog-pop_280ms_ease-out_both] [animation-delay:140ms]',
] as const

/** Micro caption: the only label voice in the panel, so hierarchy is size-free. */
function microLabel(extra = ''): string {
  return `font-mono text-[10px] uppercase tracking-[0.14em] text-faint ${extra}`.trim()
}

/** Table captions: same voice, but the columns are tight enough to need less air. */
const MICRO_HEADER = 'font-mono text-[10px] uppercase tracking-[0.05em] text-faint'

/** Segmented-control slot inside a recessed rail. */
function slot(active: boolean): string {
  return [
    'rounded-[5px] px-2 py-1 font-mono text-[11px] tracking-tight transition-colors duration-150',
    active
      ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--bc-accent-border)]'
      : 'text-faint hover:bg-hover hover:text-muted',
  ].join(' ')
}

/** The rail itself: sunken plate, so the slots read as physically inset. */
const RAIL =
  'flex flex-wrap items-center gap-0.5 self-start rounded-lg border border-border bg-sunken p-0.5'

function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** Last-used timestamps and the "since" line share one medium date-time format. */
function formatDateTime(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

/** Chart ends are dated, not described — a window is two dates, not a label. */
function formatDay(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(ms))
}

/** Bucket labels: an hourly window names the hour, the longer ones the day. */
function formatBucket(locale: string, point: TokenSeriesPoint, unit: TokenBucketUnit): string {
  return new Intl.DateTimeFormat(locale, {
    ...(unit === 'hour' ? { hour: '2-digit' } : { month: 'short', day: 'numeric' }),
  }).format(new Date(point.at))
}

/** Every figure in the panel: monospaced so the columns of digits line up. */
function Figure({ value, extra = '' }: { value: string; extra?: string }) {
  return <div className={`font-mono tabular-nums ${extra}`.trim()}>{value}</div>
}

/**
 * The window readout: one glowing odometer for the headline number, then the
 * four supporting figures in a hairline-divided strip.
 */
function WindowReadout({
  stats,
  locale,
  labels,
}: {
  stats: TokenDashboard | null
  locale: string
  labels: { total: string; input: string; output: string; cached: string; requests: string }
}) {
  const cells = [
    { label: labels.input, value: stats ? formatNumber(locale, stats.totals.inputTokens) : '—' },
    { label: labels.output, value: stats ? formatNumber(locale, stats.totals.outputTokens) : '—' },
    {
      label: labels.cached,
      value: stats ? formatNumber(locale, stats.totals.cachedInputTokens) : '—',
    },
    {
      label: labels.requests,
      value: stats ? formatNumber(locale, stats.totals.requests) : '—',
    },
  ]

  const windowStart = stats ? formatDay(locale, stats.window.from) : ''
  const windowEnd = stats ? formatDay(locale, stats.window.to - 1) : ''

  return (
    <section
      className={`${PLATE_ENTER[0]} overflow-hidden rounded-xl border border-border bg-[linear-gradient(180deg,var(--bc-panel-2),var(--bc-panel))]`}
    >
      <div className="bg-[radial-gradient(130%_140%_at_50%_-40%,var(--bc-accent-soft),transparent_70%)] px-3 pt-3 pb-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className={microLabel()}>{labels.total}</div>
          {stats && (
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-faint tabular-nums">
              <span>{windowStart}</span>
              {windowStart !== windowEnd && (
                <>
                  <span aria-hidden className="h-px w-2.5 bg-border-strong" />
                  <span>{windowEnd}</span>
                </>
              )}
            </div>
          )}
        </div>
        <Figure
          value={stats ? formatNumber(locale, stats.totals.totalTokens) : '—'}
          extra="text-[34px] leading-[1.05] font-semibold tracking-[-0.03em] text-accent [text-shadow:0_0_26px_var(--bc-accent-soft)]"
        />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border">
        {cells.map((cell) => (
          <div key={cell.label} className="bg-panel px-3 py-1.5">
            <div className={microLabel()}>{cell.label}</div>
            <Figure value={cell.value} extra="text-[13px] font-medium text-ink" />
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The smooth line view: total tokens per bucket with the area under it filled.
 *
 * Buckets arrive pre-zero-filled from the ledger, so the curve spans the whole
 * window even when most of it is idle.
 */
function TrendChart({
  series,
  unit,
  locale,
  title,
  emptyLabel,
  valueLabels,
}: {
  series: TokenSeriesPoint[]
  unit: TokenBucketUnit
  locale: string
  title: string
  emptyLabel: string
  /** Captions for the hover readout, so the numbers are never bare. */
  valueLabels: { total: string; input: string; output: string }
}) {
  const [hover, setHover] = useState<number | null>(null)
  const shape = useMemo(() => {
    // One bucket is a dot, not a curve: there is nothing to interpolate.
    if (series.length < 2) return null
    const peak = Math.max(1, ...series.map((point) => point.totals.totalTokens))
    const step = (CHART_W - CHART_PAD * 2) / (series.length - 1)
    const points: ChartPoint[] = series.map((point, index) => ({
      x: CHART_PAD + index * step,
      y: CHART_H - CHART_PAD - (point.totals.totalTokens / peak) * (CHART_H - CHART_PAD * 2),
    }))
    let highest = 0
    series.forEach((point, index) => {
      if (point.totals.totalTokens > (series[highest]?.totals.totalTokens ?? 0)) highest = index
    })
    return {
      line: smoothLinePath(points),
      area: smoothAreaPath(points, CHART_H - CHART_PAD),
      peak: points[highest] as ChartPoint,
      points,
      step,
    }
  }, [series])

  if (!shape) {
    return <div className="px-3 py-8 text-center text-xs text-muted">{emptyLabel}</div>
  }

  const { points, step } = shape
  const first = series[0] as TokenSeriesPoint
  const last = series[series.length - 1] as TokenSeriesPoint
  const hovered = hover === null ? undefined : series[hover]
  const hoveredPoint = hover === null ? undefined : points[hover]

  /**
   * Nearest bucket to the cursor. A zero-width rect means the panel is hidden
   * (inactive tabs stay mounted with `display: none`), where there is no cursor
   * to track in the first place.
   */
  function trackBucket(event: PointerEvent<SVGSVGElement>): void {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const x = ((event.clientX - rect.left) / rect.width) * CHART_W
    setHover(Math.min(series.length - 1, Math.max(0, Math.round((x - CHART_PAD) / step))))
  }

  return (
    <div className="px-2 pb-1.5">
      <div className="flex items-center gap-2 px-1 pt-2 pb-1.5">
        <div className={microLabel('text-muted')}>{title}</div>
        <div aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {/* h-36 keeps the y-scale equal to the x-scale, so markers stay round. */}
      <div className="relative rounded-lg border border-border/60 bg-sunken bg-[radial-gradient(var(--bc-border)_0.6px,transparent_0.6px)] [background-size:9px_9px]">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="block h-36 w-full cursor-crosshair"
          role="img"
          aria-label={title}
          preserveAspectRatio="none"
          onPointerMove={trackBucket}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={AREA_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--bc-accent)" stopOpacity="0.34" />
              <stop offset="1" stopColor="var(--bc-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={CHART_PAD}
              y1={CHART_PAD + fraction * (CHART_H - CHART_PAD * 2)}
              x2={CHART_W - CHART_PAD}
              y2={CHART_PAD + fraction * (CHART_H - CHART_PAD * 2)}
              className="stroke-border"
              strokeWidth={0.6}
              strokeDasharray="2 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={CHART_PAD}
            y1={CHART_H - CHART_PAD}
            x2={CHART_W - CHART_PAD}
            y2={CHART_H - CHART_PAD}
            className="stroke-border-strong"
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
          <path d={shape.area} fill={`url(#${AREA_GRADIENT_ID})`} />
          <path
            d={shape.line}
            className="stroke-accent"
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* Peak: a ring on the curve plus the hairline down to the baseline. */}
          <line
            x1={shape.peak.x}
            y1={shape.peak.y}
            x2={shape.peak.x}
            y2={CHART_H - CHART_PAD}
            className="stroke-accent"
            strokeWidth={0.7}
            strokeOpacity="0.35"
            strokeDasharray="1 3"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={shape.peak.x}
            cy={shape.peak.y}
            r={4}
            fill="none"
            className="stroke-accent"
            strokeWidth={1}
            strokeOpacity="0.5"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={shape.peak.x} cy={shape.peak.y} r={2} className="fill-accent" />
          {hoveredPoint && (
            <g>
              <line
                x1={hoveredPoint.x}
                y1={CHART_PAD}
                x2={hoveredPoint.x}
                y2={CHART_H - CHART_PAD}
                className="stroke-accent"
                strokeWidth={0.8}
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r={4.5}
                className="fill-accent-soft"
                stroke="none"
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r={2.2}
                className="fill-accent"
                stroke="none"
              />
            </g>
          )}
        </svg>
      </div>
      <div className="flex justify-between gap-2 px-1 pt-1.5 font-mono text-[10px] text-faint tabular-nums">
        {hovered ? (
          <>
            <span>{formatBucket(locale, hovered, unit)}</span>
            <span>
              {`${valueLabels.total} ${formatNumber(locale, hovered.totals.totalTokens)} · ${
                valueLabels.input
              } ${formatNumber(locale, hovered.totals.inputTokens)} · ${
                valueLabels.output
              } ${formatNumber(locale, hovered.totals.outputTokens)}`}
            </span>
          </>
        ) : (
          <>
            <span>{formatBucket(locale, first, unit)}</span>
            <span>{formatBucket(locale, last, unit)}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Breakdown table — one per half of the ledger's grouping: which feature spent
 * (consumer rows) and which conversation / task / workflow it was spent on
 * (entity rows).
 */
function GroupTable({
  title,
  rows,
  locale,
  headers,
  emptyLabel,
  otherLabel,
  consumerNames,
  windowTotal,
}: {
  title: string
  rows: TokenGroupRow[]
  locale: string
  headers: { name: string; input: string; output: string; requests: string; total: string }
  emptyLabel: string
  /** Display name for the ledger's folded-tail sentinel key. */
  otherLabel: string
  /** When set, a row's `key` is a consumer id and is shown by its localized name. */
  consumerNames?: Record<TokenConsumer, string>
  /** Denominator for the row share underlay; the window total, never a group sum. */
  windowTotal: number
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-3">
        <div className={microLabel()}>{title}</div>
        <div className="mt-1 text-xs text-muted">{emptyLabel}</div>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <div className={microLabel('text-muted')}>{title}</div>
        <div aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {/* Fixed layout: the panel is ~400px, and a name column that grows with
          its content would push the total column out of the card. */}
      <table className="w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col className="w-[36%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[19%]" />
        </colgroup>
        <thead>
          <tr className={MICRO_HEADER}>
            <th className="px-3 py-1 text-left font-normal">{headers.name}</th>
            <th className="px-1 py-1 text-right font-normal">{headers.input}</th>
            <th className="px-1 py-1 text-right font-normal">{headers.output}</th>
            <th className="px-1 py-1 text-right font-normal">{headers.requests}</th>
            <th className="px-2 py-1 text-right font-normal">{headers.total}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className="border-t border-border/70 transition-colors duration-150 hover:bg-hover"
            >
              {/* The row's share of the window is drawn as a gauge under the
                  name: a sixth column would not fit, and length reads faster
                  than a percentage. */}
              <td className="px-3 py-1.5 align-top">
                <div className="truncate text-ink" title={row.key}>
                  {row.key === OTHER_ENTITY_KEY
                    ? otherLabel
                    : (consumerNames?.[row.key as TokenConsumer] ?? (row.label || row.key))}
                </div>
                <div aria-hidden className="mt-1 h-[2px] w-full bg-border/60">
                  <div
                    className="h-full rounded-r-full bg-accent/70"
                    style={{
                      width: `${windowTotal > 0 ? Math.min(100, (row.totals.totalTokens / windowTotal) * 100) : 0}%`,
                    }}
                  />
                </div>
              </td>
              <td className="px-1 py-1.5 text-right font-mono text-muted tabular-nums">
                {formatNumber(locale, row.totals.inputTokens)}
              </td>
              <td className="px-1 py-1.5 text-right font-mono text-muted tabular-nums">
                {formatNumber(locale, row.totals.outputTokens)}
              </td>
              <td className="px-1 py-1.5 text-right font-mono text-muted tabular-nums">
                {formatNumber(locale, row.totals.requests)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono font-semibold text-ink tabular-nums">
                {formatNumber(locale, row.totals.totalTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function TokensTab() {
  const { locale, t } = useI18n()
  const [range, setRange] = useState<TokenRange>('7d')
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [stats, setStats] = useState<TokenDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'tokens.stats', range })
      if (result.type === 'tokens.stats') {
        setStats(result.stats)
        setError(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [range])

  useEffect(() => {
    void load()
  }, [load])

  // The ledger writes on every attributed request. Re-read on change, but
  // coalesce a burst: one refresh per half-second of streaming, not one per
  // model call.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onStoreChanged('tokenUsage', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  // A storage directory that re-grants after the panel opened holds the real
  // ledger; re-read once the connection lands (same contract as the other tabs).
  useEffect(() => {
    const listener = (): void => void load()
    window.addEventListener(STORAGE_RECONNECTED_EVENT, listener)
    return () => window.removeEventListener(STORAGE_RECONNECTED_EVENT, listener)
  }, [load])

  const consumerNames = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(CONSUMER_LABEL).map(([consumer, key]) => [consumer, t[key] as string]),
      ) as Record<TokenConsumer, string>,
    [t],
  )

  const clear = useCallback(async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t.tokensClear,
      message: t.tokensClearConfirm,
      confirmText: t.tokensClear,
      cancelText: t.cancel,
      danger: true,
    })
    if (ok !== true) return
    setBusy(true)
    try {
      await sendCommand({ type: 'tokens.clear' })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [load, t])

  const empty = !stats || (stats.totals.requests === 0 && stats.byConsumer.length === 0)

  const tableHeaders = useMemo(
    () => ({
      name: t.tokensColName,
      input: t.tokensColInput,
      output: t.tokensColOutput,
      requests: t.tokensColRequests,
      total: t.tokensColTotal,
    }),
    [t],
  )

  return (
    <div className="flex flex-col gap-2.5 p-2 text-sm">
      {error && (
        <div
          className="cursor-pointer rounded-lg border border-err/50 bg-err-surface px-2.5 py-1.5 text-xs text-err"
          onClick={() => setError(null)}
          role="alert"
        >
          {t.tokensLoadFailed({ error })}
        </div>
      )}

      {/* Two recessed rails: the statistical window, then the read mode. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" className={RAIL}>
          {TOKEN_RANGES.map((option) => (
            <button
              key={option}
              type="button"
              className={slot(range === option)}
              onClick={() => setRange(option)}
            >
              {t[RANGE_LABEL[option]] as string}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div role="group" className={RAIL}>
          <button type="button" className={slot(view === 'chart')} onClick={() => setView('chart')}>
            {t.tokensViewChart}
          </button>
          <button type="button" className={slot(view === 'table')} onClick={() => setView('table')}>
            {t.tokensViewTable}
          </button>
        </div>
      </div>

      {/* Re-keyed per window so switching a range restamps the readout. */}
      <div key={range} className="contents">
        <WindowReadout
          stats={stats}
          locale={locale}
          labels={{
            total: t.tokensTotal,
            input: t.tokensInput,
            output: t.tokensOutput,
            cached: t.tokensCached,
            requests: t.tokensRequests,
          }}
        />
      </div>

      {empty ? (
        <section
          className={`${PLATE_ENTER[1]} rounded-xl border border-dashed border-border-strong bg-panel bg-[radial-gradient(120%_140%_at_50%_120%,var(--bc-accent-soft),transparent_65%)] px-3 py-10 text-center`}
        >
          <div className="text-xs text-muted">{t.tokensEmpty}</div>
        </section>
      ) : view === 'chart' ? (
        <section className={`${PLATE_ENTER[1]} rounded-xl border border-border bg-panel`}>
          {stats && (
            <TrendChart
              series={stats.series}
              unit={stats.window.unit}
              locale={locale}
              title={t.tokensTrend}
              emptyLabel={t.tokensEmpty}
              valueLabels={{
                total: t.tokensTotal,
                input: t.tokensInput,
                output: t.tokensOutput,
              }}
            />
          )}
        </section>
      ) : (
        <section className={`${PLATE_ENTER[1]} rounded-xl border border-border bg-panel pb-1`}>
          <GroupTable
            title={t.tokensByConsumer}
            rows={stats?.byConsumer ?? []}
            locale={locale}
            headers={tableHeaders}
            emptyLabel={t.tokensEmpty}
            otherLabel={t.tokensOther}
            consumerNames={consumerNames}
            windowTotal={stats?.totals.totalTokens ?? 0}
          />
          <div className="pt-2">
            <GroupTable
              title={t.tokensByEntity}
              rows={stats?.byEntity ?? []}
              locale={locale}
              headers={tableHeaders}
              emptyLabel={t.tokensEmpty}
              otherLabel={t.tokensOther}
              windowTotal={stats?.totals.totalTokens ?? 0}
            />
          </div>
          {stats?.entityTruncated && (
            <div className="px-3 py-2 text-[11px] leading-relaxed text-faint">
              {t.tokensTruncated({ count: MAX_GROUP_ROWS })}
            </div>
          )}
        </section>
      )}

      <div className={`${PLATE_ENTER[2]} flex items-center justify-between gap-2`}>
        <div className={microLabel()}>
          {t.tokensSince}
          <span className="ml-1.5 text-muted normal-case tracking-normal">
            {stats?.firstRecordedAt
              ? formatDateTime(locale, stats.firstRecordedAt)
              : t.tokensNoRecords}
          </span>
        </div>
        <button
          type="button"
          className="rounded-md border border-transparent px-2 py-1 font-mono text-[11px] text-faint transition-colors duration-150 hover:border-err/50 hover:bg-err-surface hover:text-err disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-faint"
          disabled={busy || empty}
          onClick={() => void clear()}
        >
          {t.tokensClear}
        </button>
      </div>
    </div>
  )
}
