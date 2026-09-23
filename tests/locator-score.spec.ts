/**
 * Locator candidate scoring unit tests (spec §5 Phase 2, ≥15 scoring tests).
 *
 * The weights encode "identity beats position": semantic strategies must
 * outrank CSS/XPath, positional and generated-value locators must land at the
 * bottom, and the §6.3 ambiguity decision (minScore + minMargin) must fail
 * closed whenever the candidate set cannot clearly decide.
 */
import { describe, expect, it } from 'vitest'
import {
  LOCATOR_WEIGHTS,
  candidateFromSelectorString,
  cssHasUnstableClassToken,
  pickLocatorWinner,
  scoreCandidate,
  scoreCandidates,
  semanticLocatorScore,
} from '../src/lib/workflow/locator-score'

describe('locator candidate scoring', () => {
  it('verified testid scores at the top of the table', () => {
    expect(scoreCandidate({ kind: 'testid', value: 'submit-order', verified: true })).toBe(100)
  })

  it('unverified testid scores 92 — above every CSS form, below role+name', () => {
    const verified = scoreCandidate({ kind: 'testid', value: 'a', verified: true })
    const unverified = scoreCandidate({ kind: 'testid', value: 'a' })
    expect(unverified).toBe(92)
    expect(unverified).toBeLessThan(verified)
    expect(unverified).toBeLessThan(LOCATOR_WEIGHTS.roleAccessibleName)
    expect(unverified).toBeGreaterThan(LOCATOR_WEIGHTS.stableDataAttribute)
  })

  it('role + accessibleName scores 95', () => {
    expect(scoreCandidate({ kind: 'role', value: '发货', role: 'button' })).toBe(95)
  })

  it('verified stable id scores 90', () => {
    expect(scoreCandidate({ kind: 'id', value: 'login-submit', verified: true })).toBe(90)
  })

  it('label 88 > name 85 > stable data-* 75 > exact text 70', () => {
    expect(scoreCandidate({ kind: 'label', value: '邮箱' })).toBe(88)
    expect(scoreCandidate({ kind: 'name', value: 'email' })).toBe(85)
    expect(scoreCandidate({ kind: 'data-attr', value: 'order-id' })).toBe(75)
    expect(scoreCandidate({ kind: 'text', value: '提交订单' })).toBe(70)
  })

  it('css scores 35 before demotions and xpath 25', () => {
    expect(scoreCandidate({ kind: 'css', value: 'div > span' })).toBeLessThanOrEqual(35)
    expect(scoreCandidate({ kind: 'css', value: '.one' })).toBe(35)
    expect(scoreCandidate({ kind: 'xpath', value: '//div[2]/span' })).toBe(25)
  })

  it('positional candidates score 10', () => {
    expect(scoreCandidate({ kind: 'positional', value: ':nth-child(2)' })).toBe(10)
  })

  it('an explicit nth demotes any spec to positional trust', () => {
    const base = scoreCandidate({ kind: 'css', value: '.card' })
    expect(scoreCandidate({ kind: 'positional', value: '.card:nth-of-type(3)' })).toBe(10)
    expect(base).toBeGreaterThan(10)
  })

  it('an unstable (generated) id is capped at positional trust', () => {
    expect(scoreCandidate({ kind: 'id', value: 'ember-1234', verified: true })).toBe(10)
    expect(scoreCandidate({ kind: 'id', value: 'css-1x2y3z' })).toBe(10)
    // …and an explicit unstable flag caps any kind, even a "verified" one.
    expect(
      scoreCandidate({ kind: 'id', value: 'x', verified: true, unstable: true }),
    ).toBe(10)
  })

  it('a random hash class demotes the whole css candidate', () => {
    expect(cssHasUnstableClassToken('.css-1x2y3z > button')).toBe(true)
    expect(cssHasUnstableClassToken('.card > button.primary')).toBe(false)
    const demoted = scoreCandidate({ kind: 'css', value: 'div.css-1x2y3z > span' })
    expect(demoted).toBe(10)
  })

  it('deeper css paths lose points but keep a floor of 1', () => {
    const shallow = scoreCandidate({ kind: 'css', value: '.a' })
    const deep = scoreCandidate({ kind: 'css', value: 'div > ul > li > a > span' })
    expect(deep).toBeLessThan(shallow)
    expect(scoreCandidate({ kind: 'css', value: 'a > b > c > d > e > f > g > h > i > j > k > l > m > n > o > p' })).toBeGreaterThanOrEqual(1)
  })

  it('sorting puts identity first and position last', () => {
    const sorted = scoreCandidates([
      { kind: 'css', value: 'div > div > span' },
      { kind: 'role', value: '发货', role: 'button' },
      { kind: 'positional', value: 'x:nth-child(1)' },
      { kind: 'testid', value: 'submit-order', verified: true },
    ])
    expect(sorted.map((s) => s.candidate.kind)).toEqual([
      'testid',
      'role',
      'css',
      'positional',
    ])
  })

  it('weights are overridable', () => {
    const custom = { ...LOCATOR_WEIGHTS, css: 200 }
    expect(scoreCandidate({ kind: 'css', value: '.a' }, custom)).toBe(200)
  })

  it('classifies selector strings by shape', () => {
    expect(candidateFromSelectorString('#login').kind).toBe('id')
    expect(candidateFromSelectorString('[data-testid="go"]').kind).toBe('testid')
    expect(candidateFromSelectorString('[name="email"]').kind).toBe('name')
    expect(candidateFromSelectorString('xpath://div[1]').kind).toBe('xpath')
    expect(candidateFromSelectorString('.card > button').kind).toBe('css')
  })

  it('shape classification flags unstable ids', () => {
    expect(candidateFromSelectorString('#ember-1234').unstable).toBe(true)
    expect(candidateFromSelectorString('#login-submit').unstable).toBe(false)
  })
})

describe('ambiguity decision (§6.3 core)', () => {
  it('picks a clear winner above minScore with enough margin', () => {
    const outcome = pickLocatorWinner([
      { kind: 'testid', value: 'submit-order', verified: true },
      { kind: 'css', value: '.card' },
    ])
    expect(outcome.ambiguous).toBe(false)
    expect(outcome.winner?.candidate.kind).toBe('testid')
    expect(outcome.margin).toBeGreaterThanOrEqual(12)
  })

  it('is ambiguous when every candidate is below minScore', () => {
    const outcome = pickLocatorWinner([
      { kind: 'css', value: '.card' },
      { kind: 'xpath', value: '//div' },
    ])
    expect(outcome.ambiguous).toBe(true)
    expect(outcome.reason).toBe('below-min-score')
  })

  it('is ambiguous when the top two scores are too close', () => {
    const outcome = pickLocatorWinner([
      { kind: 'role', value: '发货', role: 'button' },
      { kind: 'label', value: '发货' },
    ])
    expect(outcome.ambiguous).toBe(true)
    expect(outcome.reason).toBe('below-min-margin')
    expect(outcome.margin).toBeLessThan(12)
  })

  it('is ambiguous with no candidates at all', () => {
    const outcome = pickLocatorWinner([])
    expect(outcome.ambiguous).toBe(true)
    expect(outcome.reason).toBe('no-candidates')
  })

  it('a single strong candidate wins without a margin requirement', () => {
    const outcome = pickLocatorWinner([{ kind: 'testid', value: 'go', verified: true }])
    expect(outcome.ambiguous).toBe(false)
    expect(outcome.winner?.score).toBe(100)
  })

  it('honors custom thresholds', () => {
    const outcome = pickLocatorWinner(
      [{ kind: 'name', value: 'email' }],
      { minScore: 90, minMargin: 12 },
    )
    expect(outcome.ambiguous).toBe(true)
    expect(outcome.reason).toBe('below-min-score')
  })

  it('reports the full scored candidate list as evidence', () => {
    const outcome = pickLocatorWinner([
      { kind: 'role', value: 'a', role: 'button' },
      { kind: 'css', value: '.x' },
    ])
    expect(outcome.candidates).toHaveLength(2)
    expect(outcome.candidates[0]?.score).toBeGreaterThanOrEqual(outcome.candidates[1]?.score ?? 0)
  })
})

describe('semantic locator scoring', () => {
  it('a testid identity scores 100', () => {
    expect(semanticLocatorScore({ testId: 'submit-order' })).toBe(100)
  })

  it('role + accessibleName scores 95', () => {
    expect(semanticLocatorScore({ role: 'button', accessibleName: '发货' })).toBe(95)
  })

  it('a stable id attribute scores 90 but a generated one does not', () => {
    expect(semanticLocatorScore({ stableAttributes: { id: 'login-submit' } })).toBe(90)
    expect(semanticLocatorScore({ stableAttributes: { id: 'ember-1234' } })).toBe(0)
  })

  it('role + nearText relation scores 82', () => {
    expect(
      semanticLocatorScore({ role: 'button', relation: { nearText: '订单 10001' } }),
    ).toBe(82)
  })

  it('an empty locator scores 0 (no identity)', () => {
    expect(semanticLocatorScore({})).toBe(0)
    expect(semanticLocatorScore({ relation: { nearText: 'x' } })).toBe(0)
  })
})
