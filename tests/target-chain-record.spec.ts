/**
 * Generation must record EVIDENCE, not a single lucky guess.
 *
 * A node's replay lives or dies by the candidate chain it carries: one CSS
 * selector means one chance to find the element, and the smallest DOM drift
 * turns a step the agent performed perfectly into `LOCATOR_NOT_FOUND`. These
 * tests pin the two rules the record path now follows — the spec the kernel
 * really clicked with leads the chain, and only locators the live page proved
 * unique are added to it — plus the mirror-image rule at the other end: a
 * locator we cannot express honestly produces NO gate rather than a fabricated
 * one, because a permanently-false postcondition fails runs that would
 * otherwise have passed.
 *
 * @module tests/target-chain-record
 */
import { describe, expect, it } from 'vitest'
import {
  recordedTargetChainOf,
  type RecordedLocator,
} from '../src/lib/workflow/target-to-selector'
import { targetSpecsFromSemantic } from '../src/lib/workflow/element-fingerprint'
import { autoCompleteReliability } from '../src/lib/workflow/auto-contract'
import { nodeReliabilityOf } from '../src/lib/workflow/reliability'
import type { Target, TargetSpec } from '../src/lib/ops'

/** A counts table: every selector not listed matched nothing. */
const counts = (table: Record<string, number>) => (selector: string): number =>
  table[selector] ?? 0

function targetOf(
  primary: TargetSpec,
  fallbacks: TargetSpec[] = [],
): { primary: TargetSpec; fallbacks: TargetSpec[] } {
  return { primary, fallbacks }
}

function locator(
  target: { primary: TargetSpec; fallbacks: TargetSpec[] } | undefined,
  selector = '',
): RecordedLocator {
  return { selector, ...(target ? { target } : {}) }
}

describe('recordedTargetChainOf', () => {
  it('puts the spec the kernel really clicked first', () => {
    const chain = recordedTargetChainOf({
      locator: locator(
        targetOf({ how: 'role', value: '提交', role: 'button' }),
        '.card button',
      ),
      usedSpec: 'css|#submit',
      countOf: counts({ '.card button': 1 }),
    }) as Target
    expect(chain.primary).toEqual({ how: 'role', value: '提交', role: 'button' })
    expect(chain.fallbacks[0]).toEqual({ how: 'css', value: '#submit' })
  })

  it('orders the proven-unique candidates by strength, identity over position', () => {
    const chain = recordedTargetChainOf({
      locator: locator(
        targetOf(
          { how: 'role', value: 'Buy', role: 'button' },
          [
            { how: 'css', value: '.card > button:nth-of-type(2)' },
            { how: 'name', value: 'buy' },
            { how: 'id', value: 'buy-btn' },
            { how: 'testid', value: 'buy' },
          ],
        ),
      ),
      countOf: counts({
        '[data-testid="buy"]': 1,
        '#buy-btn': 1,
        '[name="buy"]': 1,
        '.card > button:nth-of-type(2)': 1,
      }),
    }) as Target
    expect(chain.fallbacks.map((s) => s.value)).toEqual([
      'buy',
      'buy-btn',
      'buy',
      '.card > button:nth-of-type(2)',
    ])
    expect(chain.fallbacks.map((s) => s.how)).toEqual(['testid', 'id', 'name', 'css'])
    // The winning candidate keeps its SEMANTIC spec, not a re-derived CSS string.
    expect(chain.fallbacks[0]).toEqual({ how: 'testid', value: 'buy' })
  })

  it('never ADDS a candidate the page could not disambiguate', () => {
    // Three identical rows: `[data-testid="buy"]` matching all three is a
    // mis-click risk, not a safety net, so it earns no new chain entry. The
    // spec the caller sent still rides along untouched — enrichment never
    // deletes what replay already had.
    const chain = recordedTargetChainOf({
      locator: locator(
        targetOf({ how: 'role', value: 'Buy', role: 'button' }, [
          { how: 'testid', value: 'buy' },
        ]),
        '[data-testid="buy"]',
      ),
      usedSpec: 'role|Buy|role=button',
      countOf: counts({ '[data-testid="buy"]': 3 }),
    }) as Target
    expect(chain.fallbacks).toEqual([{ how: 'testid', value: 'buy' }])
  })

  it('keeps the specs the caller sent even when nothing could be probed', () => {
    // No page ⇒ no counts. Enrichment must not DELETE the author's chain: that
    // would make a record without evidence worse than one with it.
    const chain = recordedTargetChainOf({
      locator: locator(
        targetOf({ how: 'css', value: '#go' }, [
          { how: 'text', value: 'Continue' },
          { how: 'role', value: 'Continue', role: 'button' },
        ]),
        '#go',
      ),
      countOf: counts({}),
    }) as Target
    expect(chain).toEqual({
      primary: { how: 'css', value: '#go' },
      fallbacks: [{ how: 'text', value: 'Continue' }, { how: 'role', value: 'Continue', role: 'button' }],
    })
  })

  it('carries the nth/role parts of the executed spec through', () => {
    const chain = recordedTargetChainOf({
      locator: locator(targetOf({ how: 'css', value: 'ul li a' }), 'ul li a'),
      usedSpec: 'css|ul li a|tag=A|nth=2',
      countOf: counts({}),
    }) as Target
    expect(chain.fallbacks[0]).toEqual({ how: 'css', value: 'ul li a', tag: 'A', nth: 2 })
  })

  it('drops specs the kernel cannot resolve, and takes no locator on a targetless node', () => {
    const chain = recordedTargetChainOf({
      locator: locator(
        targetOf({ how: 'css', value: '#go' }, [
          // The empty-value role spec is the one that matched EVERY element.
          { how: 'role', value: '' },
          { how: 'xpath', value: '//div' } as unknown as TargetSpec,
          { how: 'testid', value: 'ok' },
        ]),
        '#go',
      ),
      countOf: counts({}),
    }) as Target
    expect(chain.fallbacks).toEqual([{ how: 'testid', value: 'ok' }])

    // A node with no rich target has no chain to build — the flat selector
    // stands alone exactly as before.
    expect(
      recordedTargetChainOf({ locator: locator(undefined, '#go'), countOf: counts({ '#go': 1 }) }),
    ).toBeUndefined()
    expect(
      recordedTargetChainOf({
        locator: locator({ primary: { how: 'css', value: '' }, fallbacks: [] }),
        countOf: counts({}),
      }),
    ).toBeUndefined()
  })

  it('caps the chain so a locator cannot bloat the graph', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      how: 'testid' as const,
      value: `t${i}`,
    }))
    const table: Record<string, number> = {}
    for (const spec of many) table[`[data-testid="${spec.value}"]`] = 1
    const chain = recordedTargetChainOf({
      locator: locator(targetOf({ how: 'css', value: '#go' }, many), '#go'),
      countOf: counts(table),
    }) as Target
    expect(chain.fallbacks.length).toBeLessThanOrEqual(7)
  })
})

describe('targetSpecsFromSemantic', () => {
  it('appends the recorded CSS selector to the identity spec', () => {
    expect(
      targetSpecsFromSemantic({
        testId: 'buy',
        stableAttributes: { 'data-css': '.card button' },
      }),
    ).toEqual([
      { how: 'testid', value: 'buy' },
      { how: 'css', value: '.card button' },
    ])
  })

  it('yields nothing for a locator whose only spec would match everything', () => {
    // `{how:'role', value:''}` is that spec: an observation built on it reads
    // "present" for any element on the page.
    expect(targetSpecsFromSemantic({ role: 'button' })).toEqual([])
    expect(targetSpecsFromSemantic({})).toEqual([])
  })

  it('yields the CSS carrier alone when the locator has no stronger identity', () => {
    expect(targetSpecsFromSemantic({ stableAttributes: { 'data-css': '#go' } })).toEqual([
      { how: 'css', value: '#go' },
    ])
  })
})

describe('auto-complete reliability contracts', () => {
  it('derives an observable postcondition from a role locator', () => {
    // A real submit ⇒ unsafe ⇒ a postcondition. (`forms` with no verb is a FILL,
    // which the executor proves, and a fill is not unsafe.)
    const nodes = [
      {
        data: {
          blockId: 'forms',
          action: 'submit',
          value: 'x',
          target: targetOf({ how: 'role', value: 'Pay', role: 'button' }),
        },
      },
    ]
    autoCompleteReliability(nodes)
    const spec = nodeReliabilityOf(nodes[0] as never)
    expect(spec?.postconditions).toEqual([
      { kind: 'elementExists', target: { role: 'button', accessibleName: 'Pay' } },
    ])
  })

  it('records no postcondition for a node with no replayable locator', () => {
    // A snapshot `ref` is conversation-scoped: gone by replay. And the old
    // last-resort fabricated an attribute no page carries, so the node failed a
    // goal check it could never have passed.
    const nodes = [{ data: { blockId: 'forms', action: 'submit', value: 'x', ref: 'e12' } }]
    autoCompleteReliability(nodes)
    const spec = nodeReliabilityOf(nodes[0] as never)
    expect(spec?.idempotency).toBe('unsafe')
    expect(spec?.postconditions ?? []).toHaveLength(0)
  })
})
