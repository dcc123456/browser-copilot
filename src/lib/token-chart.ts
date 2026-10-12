/**
 * Smooth SVG path builder for the token dashboard's line chart.
 *
 * The chart has to read as one flowing curve over per-bucket token totals
 * without pulling a charting library into the extension bundle (see
 * `specs/2026-10-12-token-usage-dashboard-design.md` §4.6: the panel already
 * ships no chart dependency, and a sparkline does not justify one).
 *
 * Shape: cubic Hermite segments whose tangents come from the neighbouring
 * segment slopes, zeroed wherever the data turns — the Fritsch–Carlson
 * monotonicity idea. A plain Catmull-Rom through the same points looks equally
 * smooth but overshoots on a spike (a token series is mostly flat with sudden
 * peaks), and an overshoot below the axis is a chart that reports spend the
 * user never had.
 *
 * Coordinates are in SVG space, where `y` grows downward: the caller maps a
 * larger value to a SMALLER `y`. The clamping above is orientation-agnostic.
 *
 * @module lib/token-chart
 */

/** One plotted point, in SVG user units. */
export interface ChartPoint {
  x: number
  y: number
}

/** Path coordinates keep two significant decimals — enough for a 300 px chart. */
function coord(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/**
 * Curve through the points as one `M …C …` path, or `''` when there is nothing
 * to plot. A single point yields a moveto only (a visible dot at least).
 */
export function smoothLinePath(points: readonly ChartPoint[]): string {
  const count = points.length
  if (count === 0) return ''
  const first = points[0] as ChartPoint
  if (count === 1) return `M ${coord(first.x)} ${coord(first.y)}`

  const slopes: number[] = []
  for (let i = 0; i < count - 1; i += 1) {
    const a = points[i] as ChartPoint
    const b = points[i + 1] as ChartPoint
    const dx = b.x - a.x
    slopes.push(dx === 0 ? 0 : (b.y - a.y) / dx)
  }

  const tangents: number[] = [slopes[0] as number]
  for (let i = 1; i < count - 1; i += 1) {
    const before = slopes[i - 1] as number
    const after = slopes[i] as number
    // Opposite signs = the series turns here; a non-zero tangent would cut
    // across the corner and overshoot the neighbouring values.
    tangents.push(before * after <= 0 ? 0 : (before + after) / 2)
  }
  tangents.push(slopes[count - 2] as number)

  let d = `M ${coord(first.x)} ${coord(first.y)}`
  for (let i = 0; i < count - 1; i += 1) {
    const a = points[i] as ChartPoint
    const b = points[i + 1] as ChartPoint
    const dx = b.x - a.x
    const c1x = a.x + dx / 3
    const c1y = a.y + ((tangents[i] as number) * dx) / 3
    const c2x = b.x - dx / 3
    const c2y = b.y - ((tangents[i + 1] as number) * dx) / 3
    d += ` C ${coord(c1x)} ${coord(c1y)}, ${coord(c2x)} ${coord(c2y)}, ${coord(b.x)} ${coord(b.y)}`
  }
  return d
}

/**
 * The filled region under {@link smoothLinePath}: the curve, then down to
 * `baseline` and back to the first point, closed.
 */
export function smoothAreaPath(points: readonly ChartPoint[], baseline: number): string {
  const line = smoothLinePath(points)
  if (!line || points.length < 2) return ''
  const first = points[0] as ChartPoint
  const last = points[points.length - 1] as ChartPoint
  return `${line} L ${coord(last.x)} ${coord(baseline)} L ${coord(first.x)} ${coord(baseline)} Z`
}
