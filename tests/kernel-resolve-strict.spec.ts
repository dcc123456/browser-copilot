/**
 * Strict resolver unit tests (spec §6 Phase 3): in strict mode the kernel
 * must NEVER act on a guess — an ambiguous target is refused with structured
 * evidence (`LOCATOR_AMBIGUOUS` + match count + scored candidates), a clear
 * winner resolves, and compat keeps the legacy first-visible behavior.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, OpResult, ResolvePolicy, Target } from '../src/lib/ops'

let dom: JSDOM

function makePage(html: string): void {
  dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    url: 'https://example.test/page',
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.HTMLAnchorElement = dom.window.HTMLAnchorElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLFormElement = dom.window.HTMLElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.MouseEvent = dom.window.MouseEvent
  g.PointerEvent = dom.window.PointerEvent
  g.Event = dom.window.Event
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
}

const SCORE_POLICY: ResolvePolicy = {
  mode: 'strict',
  ambiguity: 'score',
  minScore: 70,
  minMargin: 12,
}

function clickOp(target: Target, policy?: ResolvePolicy): Op {
  return { action: 'click', target, ...(policy ? { resolvePolicy: policy } : {}) }
}

describe('kernel strict resolver', () => {
  beforeEach(() => {
    makePage(`
      <div class="list">
        <div class="card"><button>买</button></div>
        <div class="card"><button>买</button></div>
        <div class="card"><button>买</button></div>
      </div>
    `)
  })

  it('refuses an ambiguous multi-match with structured evidence and does NOT click', () => {
    let clicked = 0
    dom.window.document.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        clicked += 1
      }),
    )
    const result = runOp(clickOp({ primary: { how: 'css', value: '.card' }, fallbacks: [] }, SCORE_POLICY))
    expect(result.ok).toBe(false)
    expect(result.found).toBe(true) // the elements ARE there — the identity is not
    expect(result.code).toBe('LOCATOR_AMBIGUOUS')
    expect(result.matchCount).toBe(3)
    expect(result.candidates?.length).toBe(1)
    expect(result.error).toContain('定位不确定')
    expect(clicked).toBe(0)
  })

  it('resolves when one spec uniquely matches with a strong score', () => {
    makePage(`
      <div class="list">
        <div class="card"><button>买</button></div>
        <div class="card" id="target-card"><button>买</button></div>
        <div class="card"><button>买</button></div>
      </div>
    `)
    const target: Target = {
      primary: { how: 'css', value: '.card' },
      fallbacks: [{ how: 'id', value: 'target-card' }],
    }
    const result = runOp(clickOp(target, SCORE_POLICY)) as OpResult
    expect(result.ok).toBe(true)
    expect(result.usedSpec).toContain('target-card')
    expect(result.matched).toBe(1)
  })

  it('refuses when two identity specs are too close in score (below minMargin)', () => {
    makePage(`
      <div class="list">
        <div class="card"><button data-testid="buy-a">买</button></div>
        <div class="card"><button data-testid="buy-b">买</button></div>
      </div>
    `)
    const target: Target = {
      primary: { how: 'testid', value: 'buy-a' },
      fallbacks: [{ how: 'testid', value: 'buy-b' }],
    }
    const result = runOp(clickOp(target, SCORE_POLICY)) as OpResult
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LOCATOR_AMBIGUOUS')
    expect(result.matchCount).toBe(2)
  })

  it('reports LOCATOR_NOT_FOUND when nothing matches at all', () => {
    const result = runOp(
      clickOp({ primary: { how: 'css', value: '.nothing-here' }, fallbacks: [] }, SCORE_POLICY),
    ) as OpResult
    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
    expect(result.code).toBe('LOCATOR_NOT_FOUND')
    expect(result.matchCount).toBe(0)
  })

  it('treats an unstable (generated) id as positional — never a strict winner', () => {
    makePage(`
      <div class="list">
        <div class="card" id="ember-1234"><button>买</button></div>
        <div class="card"><button>买</button></div>
      </div>
    `)
    const result = runOp(
      clickOp({ primary: { how: 'id', value: 'ember-1234' }, fallbacks: [] }, SCORE_POLICY),
    ) as OpResult
    // The id matched exactly ONE element — the union holds a single candidate,
    // so there is nothing to guess and the op acts (spec §6.3: 1 命中 → SUCCESS).
    expect(result.ok).toBe(true)
    expect(result.matched).toBe(1)
  })

  it('an ambiguity=error policy refuses any multi-match immediately', () => {
    const result = runOp(
      clickOp(
        { primary: { how: 'css', value: '.card' }, fallbacks: [] },
        { mode: 'strict', ambiguity: 'error' },
      ),
    ) as OpResult
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LOCATOR_AMBIGUOUS')
    expect(result.matchCount).toBe(3)
  })

  it('respects custom minScore/minMargin overrides', () => {
    makePage(`
      <div class="list">
        <div class="card"><button>买</button></div>
        <div class="card"><button>买</button></div>
      </div>
    `)
    // A role spec (95) over a text spec (70) — margin 25 clears the default
    // but only a custom floor of 100 makes this refuse.
    const target: Target = {
      primary: { how: 'role', value: '买', role: 'button' },
      fallbacks: [{ how: 'text', value: '买' }],
    }
    // Both specs match BOTH buttons (multi-match each) → no eligible winner.
    const refused = runOp(clickOp(target, SCORE_POLICY)) as OpResult
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('LOCATOR_AMBIGUOUS')
  })

  it('compat mode keeps the legacy first-visible behavior (no policy)', () => {
    const result = runOp(clickOp({ primary: { how: 'css', value: '.card' }, fallbacks: [] })) as OpResult
    expect(result.ok).toBe(true)
    expect(result.matched).toBe(3)
  })

  it('compat mode is unaffected by an explicit compat policy', () => {
    const result = runOp(
      clickOp(
        { primary: { how: 'css', value: '.card' }, fallbacks: [] },
        {
          mode: 'compat',
          ambiguity: 'first-visible',
        },
      ),
    ) as OpResult
    expect(result.ok).toBe(true)
    expect(result.matched).toBe(3)
  })

  it('fills respect the strict refusal too (no value typed on a guess)', () => {
    let filled = 0
    const inputs = dom.window.document.querySelectorAll('button')
    inputs.forEach((el) =>
      el.addEventListener('input', () => {
        filled += 1
      }),
    )
    const result = runOp({
      action: 'fill',
      target: { primary: { how: 'css', value: '.card' }, fallbacks: [] },
      value: 'hello',
      resolvePolicy: SCORE_POLICY,
    }) as OpResult
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LOCATOR_AMBIGUOUS')
    expect(filled).toBe(0)
  })

  it('wait_for keeps polling on ambiguity and reports the refusal at the deadline', async () => {
    // The wait branch re-enters runOp inside an async IIFE (chrome.scripting
    // awaits it); the direct call therefore returns a thenable — await it.
    const result = (await (runOp({
      action: 'wait_for',
      target: { primary: { how: 'css', value: '.card' }, fallbacks: [] },
      waitFor: 300,
      resolvePolicy: SCORE_POLICY,
    }) as unknown as Promise<OpResult>)) as OpResult
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LOCATOR_AMBIGUOUS')
    expect(result.matchCount).toBe(3)
  })
})
