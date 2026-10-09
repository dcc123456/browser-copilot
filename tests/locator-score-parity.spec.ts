/**
 * Score-table parity.
 *
 * The in-page kernel is serialized without closures, so it cannot import
 * `lib/workflow/locator-score` — it carries a hand-written copy of the same
 * weights. That duplication is load-bearing: the degradation ladder
 * (`ambiguity: 'rank'`) decides WHICH candidate wins from the kernel's numbers,
 * while record time orders the candidate chain with the library's. If the two
 * drift, a chain recorded "strongest first" gets re-ranked by the page, and the
 * step silently degrades to a weaker locator than the one it was given.
 *
 * So the copy is pinned here, number by number, against the single source of
 * truth. Editing one table without the other fails this test.
 *
 * Reads the kernel's SOURCE rather than importing it: `strictScoreOf` lives
 * inside the serialized kernel function and is not reachable as a module
 * export — by design.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCATOR_WEIGHTS } from '../src/lib/workflow/locator-score'
import { STRICT_MIN_MARGIN, STRICT_MIN_SCORE } from '../src/lib/workflow/reliability'

const kernelSource = readFileSync(
  fileURLToPath(new URL('../src/inpage/kernel.ts', import.meta.url)),
  'utf8',
)

/** The body of the kernel's private `strictScoreOf`, isolated for parsing. */
const scoreBody = (() => {
  const start = kernelSource.indexOf('function strictScoreOf(')
  expect(start, 'kernel must define strictScoreOf').toBeGreaterThan(-1)
  const end = kernelSource.indexOf('\n  function resolve(', start)
  expect(end, 'strictScoreOf body must be followed by resolve()').toBeGreaterThan(start)
  return kernelSource.slice(start, end)
})()

/** The number the kernel assigns a strategy, from its own line in the switch. */
function kernelScoreOf(pattern: RegExp, label: string): number {
  const match = pattern.exec(scoreBody)
  expect(match, `kernel scores ${label}`).not.toBeNull()
  return Number(match![1])
}

/** The kernel's shared positional floor (`nth` / generated values / unstable ids). */
function kernelPositionalFloor(): number {
  const match = /const POSITIONAL = (\d+)/.exec(scoreBody)
  expect(match, 'kernel declares its positional floor').not.toBeNull()
  return Number(match![1])
}

describe('kernel strictScoreOf ↔ LOCATOR_WEIGHTS', () => {
  it('scores every strategy at the library weight', () => {
    expect(kernelScoreOf(/case 'testid':\s*base = (\d+)/, 'testid')).toBe(
      LOCATOR_WEIGHTS.verifiedTestid,
    )
    expect(
      kernelScoreOf(/case 'role':[\s\S]{0,120}?base = value \? (\d+) : \d+/, 'role + name'),
    ).toBe(LOCATOR_WEIGHTS.roleAccessibleName)
    expect(
      kernelScoreOf(/case 'id':\s*base = looksUnstable\(value\) \? POSITIONAL : (\d+)/, 'id'),
    ).toBe(LOCATOR_WEIGHTS.verifiedStableId)
    expect(
      kernelScoreOf(/case 'name':\s*base = looksUnstable\(value\) \? POSITIONAL : (\d+)/, 'name'),
    ).toBe(LOCATOR_WEIGHTS.name)
    expect(kernelScoreOf(/case 'text':\s*base = (\d+)/, 'text')).toBe(
      LOCATOR_WEIGHTS.exactVisibleText,
    )
    expect(kernelScoreOf(/base = Math\.max\(1, (\d+) - Math\.min\(15, steps\)/, 'css')).toBe(
      LOCATOR_WEIGHTS.css,
    )
  })

  it('scores a nameless role below the strict floor, so it can never win rung 1', () => {
    // `role` without an accessible name matched everything on the old page; it
    // must stay a last resort in the ladder too.
    const nameless = kernelScoreOf(
      /case 'role':[\s\S]{0,120}?base = value \? \d+ : (\d+)/,
      'role alone',
    )
    expect(nameless).toBeLessThan(STRICT_MIN_SCORE)
  })

  it('treats an unstable value or a positional spec as bottom trust', () => {
    expect(kernelPositionalFloor()).toBe(LOCATOR_WEIGHTS.positional)
    // `nth` is position, not identity — the very first thing the function does.
    expect(scoreBody).toMatch(
      /if \(typeof spec\.nth === 'number' && spec\.nth > 0\) return POSITIONAL/,
    )
  })

  it('charges the same depth demotion for long CSS paths', () => {
    expect(scoreBody).toContain("value.startsWith('xpath:')")
    const xpathScore = /if \(value\.startsWith\('xpath:'\)\) return (\d+)/.exec(scoreBody)
    expect(Number(xpathScore?.[1])).toBe(LOCATOR_WEIGHTS.xpath)
  })

  it('keeps the score floor and margin defaults in step with the engine', () => {
    // The kernel's own fallbacks must equal what the engine sends: a run whose
    // policy failed to arrive would otherwise resolve on a different bar than
    // the one the workflow was certified against.
    const floor = /minScore === 'number' \? policy\.minScore : (\d+)/.exec(kernelSource)
    const margin = /minMargin === 'number' \? policy\.minMargin : (\d+)/.exec(kernelSource)
    expect(Number(floor?.[1])).toBe(STRICT_MIN_SCORE)
    expect(Number(margin?.[1])).toBe(STRICT_MIN_MARGIN)
  })
})
