/**
 * Tests for the dashboard's hand-rolled curve (`lib/token-chart`).
 *
 * The contract that makes this module exist instead of a library: the path is
 * one smooth cubic spline AND it never invents a value between two samples. A
 * token series is flat with sudden spikes, and a Catmull-Rom overshoot on a
 * spike draws a peak taller than the data — a chart reporting spend the user
 * never had. So the core test evaluates the emitted Bézier segments and checks
 * the rendered y stays inside the data's own y range.
 */
import { describe, expect, it } from 'vitest'
import { smoothAreaPath, smoothLinePath, type ChartPoint } from '../src/lib/token-chart'

interface Segment {
  from: ChartPoint
  c1: ChartPoint
  c2: ChartPoint
  to: ChartPoint
}

/** Parse `M x y C …` back into cubic segments, so the test reads the chart the
 *  renderer does. */
function parseSegments(d: string): Segment[] {
  const tokens = d.replace(/,/g, ' ').trim().split(/\s+/)
  expect(tokens[0]).toBe('M')
  const numbers = tokens.filter((token) => token !== 'M' && token !== 'C').map(Number)
  expect(numbers).toHaveLength(2 + tokens.filter((token) => token === 'C').length * 6)

  const segments: Segment[] = []
  let cursor = 0
  let previous: ChartPoint = { x: numbers[0] as number, y: numbers[1] as number }
  cursor = 2
  while (cursor < numbers.length) {
    const c1 = { x: numbers[cursor] as number, y: numbers[cursor + 1] as number }
    const c2 = { x: numbers[cursor + 2] as number, y: numbers[cursor + 3] as number }
    const to = { x: numbers[cursor + 4] as number, y: numbers[cursor + 5] as number }
    segments.push({ from: previous, c1, c2, to })
    previous = to
    cursor += 6
  }
  return segments
}

/** Bézier y at parameter `t`. */
function curveY(segment: Segment, t: number): number {
  const u = 1 - t
  return (
    u ** 3 * segment.from.y +
    3 * u ** 2 * t * segment.c1.y +
    3 * u * t ** 2 * segment.c2.y +
    t ** 3 * segment.to.y
  )
}

/** Rendered y values, sampled finely enough to catch an overshoot. */
function renderedYs(d: string): number[] {
  const samples: number[] = []
  for (const segment of parseSegments(d)) {
    for (let step = 0; step <= 40; step += 1) samples.push(curveY(segment, step / 40))
  }
  return samples
}

const FLAT_THEN_SPIKE: ChartPoint[] = [
  { x: 0, y: 100 },
  { x: 10, y: 100 },
  { x: 20, y: 100 },
  { x: 30, y: 10 },
  { x: 40, y: 100 },
  { x: 50, y: 100 },
]

describe('smoothLinePath', () => {
  it('plots nothing for no data and a lone moveto for one point', () => {
    expect(smoothLinePath([])).toBe('')
    expect(smoothLinePath([{ x: 12, y: 30 }])).toBe('M 12 30')
  })

  it('emits one cubic segment between each pair of points', () => {
    const d = smoothLinePath(FLAT_THEN_SPIKE)
    expect(d.startsWith('M 0 100')).toBe(true)
    expect(d.match(/C /g)).toHaveLength(FLAT_THEN_SPIKE.length - 1)
  })

  it('passes exactly through every data point', () => {
    const segments = parseSegments(smoothLinePath(FLAT_THEN_SPIKE))
    expect(segments.map((segment) => segment.to.y)).toEqual([100, 100, 10, 100, 100])
    expect(segments[0]?.from).toEqual({ x: 0, y: 100 })
  })

  it('never draws a value the data does not contain, up or down', () => {
    const ys = renderedYs(smoothLinePath(FLAT_THEN_SPIKE))
    expect(Math.max(...ys)).toBeLessThanOrEqual(100 + 1e-6)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10 - 1e-6)
  })

  it('stays inside the data range on a steep climb, where overshoot is likely', () => {
    const climb: ChartPoint[] = [
      { x: 0, y: 100 },
      { x: 10, y: 90 },
      { x: 20, y: 20 },
      { x: 30, y: 0 },
    ]
    const ys = renderedYs(smoothLinePath(climb))
    expect(Math.max(...ys)).toBeLessThanOrEqual(100 + 1e-6)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0 - 1e-6)
  })

  it('keeps a monotone run monotone instead of wobbling through it', () => {
    const falling: ChartPoint[] = [
      { x: 0, y: 10 },
      { x: 10, y: 30 },
      { x: 20, y: 60 },
      { x: 30, y: 90 },
    ]
    const ys = renderedYs(smoothLinePath(falling))
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index] as number).toBeGreaterThanOrEqual((ys[index - 1] as number) - 1e-6)
    }
  })
})

describe('smoothAreaPath', () => {
  it('closes the curve down to the baseline and back', () => {
    const area = smoothAreaPath(FLAT_THEN_SPIKE, 120)
    expect(area.startsWith(smoothLinePath(FLAT_THEN_SPIKE))).toBe(true)
    expect(area.endsWith('L 0 120 Z')).toBe(true)
    expect(area).toContain('L 50 120')
  })

  it('fills nothing when there is no curve to close', () => {
    expect(smoothAreaPath([], 120)).toBe('')
    expect(smoothAreaPath([{ x: 1, y: 2 }], 120)).toBe('')
  })
})
