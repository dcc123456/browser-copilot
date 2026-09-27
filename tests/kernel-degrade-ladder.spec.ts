// @vitest-environment jsdom
/**
 * The degradation ladder, on the REAL kernel.
 *
 * Turning the strict resolver on without a way down would have taken the worst
 * failure mode of the old first-visible guess and replaced it with something
 * worse: a refusal on the FIRST ambiguous step, i.e. a workflow that used to
 * (mostly) replay now fails replay 100% of the time. So `ambiguity: 'rank'`
 * scores exactly like strict mode and, where strict would stop, walks down one
 * rung at a time — waive the margin, then the score floor, then finally the
 * legacy first-visible guess — and REPORTS which rung it landed on.
 *
 * These tests pin the two halves of that promise: every rung that finds an
 * element ACTS (never silently refuses), and every rung below the clean winner
 * leaves evidence behind so the run knows it ran on borrowed confidence.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Op, ResolvePolicy, Target, TargetSpec } from '../src/lib/ops'
import { runOp } from '../src/inpage/kernel'

const PAGE = `
  <div class="list">
    <button id="cart" data-testid="buy">买</button>
    <a id="only" href="#x">唯一</a>
    <button class="dup">行</button>
    <button class="dup">行</button>
    <input class="field" value="a" />
    <input class="field" value="b" />
  </div>
`

const STRICT: Omit<ResolvePolicy, 'ambiguity'> = { mode: 'strict', minScore: 70, minMargin: 12 }
const RANK: ResolvePolicy = { ...STRICT, ambiguity: 'rank' }
const SCORE: ResolvePolicy = { ...STRICT, ambiguity: 'score' }

const target = (primary: TargetSpec, fallbacks: TargetSpec[] = []): Target => ({
  primary,
  fallbacks,
})

function run(op: Op) {
  return runOp(op)
}

/** Which elements the kernel actually acted on (one listener, reset per test). */
let clicked: Element[] = []
document.addEventListener('click', (event) => {
  clicked.push(event.target as Element)
})

describe('kernel rank policy: the degradation ladder', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE
    clicked = []
  })

  /** The single element the kernel clicked, by id. */
  const clickedId = (): string[] => clicked.map((element) => element.id)

  it('rung 1 — a single unambiguous winner acts and reports nothing', () => {
    // The authored selector is gone; the recorded testid finds exactly one
    // element, so the union has one member and there is nothing to degrade.
    const result = run({
      action: 'click',
      target: target({ how: 'css', value: '.gone' }, [{ how: 'testid', value: 'buy' }]),
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(true)
    expect(result.usedSpec).toBe('testid|buy')
    expect(result.usedFallback).toBe(true)
    expect(result.degrade).toBeUndefined()
    expect(clickedId()).toEqual(['cart'])
  })

  it('rung 2 — a margin that is too small degrades instead of refusing', () => {
    // testid (100) and a stable id (90) each match ONE element, 10 apart:
    // strict `score` refuses (margin < 12), rank takes the strongest.
    expect(
      run({
        action: 'click',
        target: target({ how: 'testid', value: 'buy' }, [{ how: 'id', value: 'only' }]),
        resolvePolicy: SCORE,
      }).ok,
    ).toBe(false)

    const result = run({
      action: 'click',
      target: target({ how: 'testid', value: 'buy' }, [{ how: 'id', value: 'only' }]),
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(true)
    expect(result.usedSpec).toBe('testid|buy')
    expect(result.degrade?.rung).toBe(2)
    expect(result.degrade?.from).toBe('testid|buy')
    expect(result.degrade?.to).toBe('testid|buy')
    expect(result.degrade?.matchCount).toBe(2)
    expect(clickedId()).toEqual(['cart'])
  })

  it('rung 3 — a candidate below the score floor still acts if it is unique', () => {
    // Both are CSS (35 / 34, under minScore 70): strict refuses, rank takes the
    // one the page proves is unique, in recorded order.
    const result = run({
      action: 'click',
      target: target({ how: 'css', value: '.dup' }, [{ how: 'css', value: '#only' }]),
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(true)
    expect(result.usedSpec).toBe('css|#only')
    expect(result.degrade?.rung).toBe(3)
    expect(result.degrade?.matchCount).toBe(3)
    expect(clickedId()).toEqual(['only'])
  })

  it('rung 4 — nothing unique falls to the legacy first-visible guess, loudly', () => {
    const result = run({
      action: 'click',
      target: target({ how: 'css', value: '.dup' }, [{ how: 'css', value: '.list button' }]),
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(true)
    expect(result.degrade?.rung).toBe(4)
    // The evidence names the candidates it gave up on, not just the winner.
    expect(result.degrade?.candidates.length).toBeGreaterThan(1)
    expect(result.degrade?.from).toBe('css|.dup')
    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.classList.contains('dup')).toBe(true)
  })

  it('a target nothing matches still fails the honest way', () => {
    const result = run({
      action: 'click',
      target: target({ how: 'css', value: '#never' }, [{ how: 'testid', value: 'never' }]),
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LOCATOR_NOT_FOUND')
    expect(result.degrade).toBeUndefined()
  })

  it('rank never acts on more elements than a single one, so a click has one target', () => {
    // `.field` matches two inputs: whichever rung wins, exactly one element is
    // clicked. The whole point of degrading is to keep the STEP running, not to
    // spray the action across the page.
    const result = run({
      action: 'fill',
      target: target({ how: 'css', value: '.field' }),
      value: 'typed',
      resolvePolicy: RANK,
    })
    expect(result.ok).toBe(true)
    expect(result.matched).toBe(2)
    const typed = Array.from(document.querySelectorAll('.field')).filter(
      (input) => (input as HTMLInputElement).value === 'typed',
    )
    expect(typed).toHaveLength(1)
  })
})
