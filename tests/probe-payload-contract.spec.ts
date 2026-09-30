// @vitest-environment jsdom
/**
 * Probe payload contract.
 *
 * The readiness and condition probes speak to the in-page kernel through
 * `execOnActiveTab`. Every one of those calls is a hand-built op object, and a
 * field the kernel does not read is silently indistinguishable from "the page
 * says no" — which is how `{ action:'element_exists', target }` came to answer
 * "the element never appears" forever, and how `get_attribute` answered "needs
 * an attribute name" to every attribute condition.
 *
 * So this suite routes the probes' real op payloads into the REAL kernel
 * (`runOp`) against a jsdom page. A payload the kernel cannot answer correctly
 * fails here instead of failing as an 8-second replay timeout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op, OpResult } from '../src/lib/ops'
import { runOp } from '../src/inpage/kernel'
import type { SemanticLocator } from '../src/lib/workflow/element-fingerprint'
import type { ReadinessRequirement } from '../src/lib/workflow/readiness'

/** Swappable so a case can either hit the real kernel or a crafted payload. */
const harness = vi.hoisted(() => ({
  fn: async (_op: Op): Promise<OpResult> => ({
    ok: false,
    found: false,
    frameUrl: 'https://example.test/page',
    isTopFrame: true,
  }),
}))

vi.mock('../src/background/driver', async () => {
  const { runOp: realRunOp } = await import('../src/inpage/kernel')
  return {
    execOnActiveTab: async (op: Op) => harness.fn(op),
    countElements: async (selector: string) =>
      (realRunOp({ action: 'count_elements', value: selector }).data as number) ?? 0,
    elementSelectorAt: async () => undefined,
    execJsOnActiveTab: async () => ({ ok: false, found: false, error: 'js off in harness' }),
    resolveAutomationTab: async () => ({
      id: 1,
      url: 'https://example.test/page',
      status: 'complete',
    }),
  }
})
vi.mock('../src/background/workflow-engine/engine', () => ({ runWorkflow: vi.fn() }))
vi.mock('../src/background/automation-scope', () => ({
  normalScopeFromWindowId: vi.fn(async () => undefined),
}))
vi.mock('../src/lib/workflow/blocks/palette', () => ({ BLOCK_BY_ID: new Map(), PALETTE_BLOCKS: [] }))

const { createDriverReadinessProbe } = await import(
  '../src/background/workflow-engine/run-workflow'
)
const { createDriverConditionProbe } = await import(
  '../src/background/workflow-engine/condition-runtime'
)

const PAGE = `
  <div class="list">
    <button id="go" data-testid="checkout" name="buyNow" aria-label="买">买</button>
    <button class="dup">买</button>
    <button class="dup">买</button>
  </div>
`

/** Run the probes' payloads through the real kernel. */
function useRealKernel(): void {
  harness.fn = async (op) => runOp(op)
}

function readinessProbe() {
  const signal = new AbortController().signal
  const probe = createDriverReadinessProbe(signal)
  return (requirement: ReadinessRequirement, nodeSelector: string) =>
    probe(requirement, nodeSelector, signal)
}

/** Answer with crafted kernel payloads, one per call (the last one repeats). */
function respondSeries(payloads: unknown[]): (op: Op) => Promise<OpResult> {
  let index = 0
  return async () => {
    const data = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    return {
      ok: true,
      found: true,
      data,
      frameUrl: 'https://example.test/page',
      isTopFrame: true,
    }
  }
}

function conditionProbe() {
  return createDriverConditionProbe(new AbortController().signal)
}

const cssLocator = (css: string): SemanticLocator => ({ stableAttributes: { 'data-css': css } })
const roleLocator: SemanticLocator = { role: 'button', accessibleName: '买' }

describe('readiness probe → kernel payload contract', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE
    useRealKernel()
  })

  it('`present` is satisfied for a node selector (regression: it never was)', async () => {
    const requirement: ReadinessRequirement = { state: 'present' }
    await expect(readinessProbe()(requirement, '#go')).resolves.toMatchObject({
      satisfied: true,
    })
  })

  it('`present` is satisfied for a recorded semantic target, not just CSS', async () => {
    const requirement: ReadinessRequirement = { state: 'present', target: { testId: 'checkout' } }
    await expect(readinessProbe()(requirement, '')).resolves.toMatchObject({ satisfied: true })
  })

  it('`present` reports honestly when the element is genuinely absent', async () => {
    const requirement: ReadinessRequirement = { state: 'present' }
    const outcome = await readinessProbe()(requirement, '#never')
    expect(outcome.satisfied).toBe(false)
    expect(outcome.detail).toContain('尚未出现')
  })

  it('an existence wait is never a refusal: a strict-ambiguous target still exists', async () => {
    // `.dup` matches twice. Whatever the ambiguity policy decides for an ACTION,
    // the question "is it there" must answer yes — otherwise the wait polls a
    // refusal as absence and times out a step that could have run.
    const requirement: ReadinessRequirement = { state: 'present' }
    await expect(readinessProbe()(requirement, '.dup')).resolves.toMatchObject({
      satisfied: true,
    })
  })

  it('`stable` compares two live rect samples instead of passing vacuously', async () => {
    // jsdom has no layout, so the kernel's own rect is always 0×0: a moving
    // element can only be simulated by answering with crafted payloads.
    harness.fn = respondSeries([
      { state: 'ready', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { state: 'ready', rect: { x: 0, y: 12, w: 10, h: 10 } },
    ])
    const moving = await readinessProbe()({ state: 'stable' }, '#go')
    expect(moving.satisfied).toBe(false)
    expect(moving.detail).toContain('移动')

    harness.fn = respondSeries([
      { state: 'ready', rect: { x: 3, y: 4, w: 10, h: 10 } },
      { state: 'ready', rect: { x: 3, y: 4, w: 10, h: 10 } },
    ])
    await expect(readinessProbe()({ state: 'stable' }, '#go')).resolves.toMatchObject({
      satisfied: true,
    })

    harness.fn = respondSeries([{ state: 'missing' }])
    await expect(readinessProbe()({ state: 'stable' }, '#go')).resolves.toMatchObject({
      satisfied: false,
    })
  })

  it('`visible` and `enabled` read their own fact, not the merged ready state', async () => {
    // Rendered but occluded and disabled: `visible` is about visibility only, so
    // it must not time out because a banner sits on top of the button.
    harness.fn = respondSeries([
      { state: 'blocked', visible: true, enabled: false, occluded: true },
    ])
    const probe = readinessProbe()
    await expect(probe({ state: 'visible' }, '#go')).resolves.toMatchObject({ satisfied: true })
    const enabled = await probe({ state: 'enabled' }, '#go')
    expect(enabled.satisfied).toBe(false)
    expect(enabled.detail).toContain('不可用')
  })
})

describe('condition probe → kernel payload contract', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE
    useRealKernel()
  })

  it('exists() sees an element the recorded CSS points at', async () => {
    await expect(conditionProbe().exists(cssLocator('#go'))).resolves.toBe(true)
    await expect(conditionProbe().exists(cssLocator('#never'))).resolves.toBe(false)
  })

  it('exists() resolves a role/accessible-name locator (no CSS form exists)', async () => {
    await expect(conditionProbe().exists(roleLocator)).resolves.toBe(true)
  })

  it('count() counts distinct elements, not candidate matches', async () => {
    // `#go` and its own duplicate spec must not count the same node twice.
    harness.fn = async () => runOp({
      action: 'element_exists',
      target: {
        primary: { how: 'css', value: '.dup' },
        fallbacks: [{ how: 'css', value: '.list button' }],
      },
    })
    // .dup = 2 elements, .list button = 3 elements, distinct union = 3.
    await expect(conditionProbe().count(cssLocator('.dup'))).resolves.toBe(3)
  })

  it('text() reads role-located elements instead of reporting "not observable"', async () => {
    await expect(conditionProbe().text(roleLocator)).resolves.toBe('买')
    await expect(conditionProbe().text(cssLocator('#never'))).resolves.toBeUndefined()
  })

  it('attribute() actually names the attribute it reads', async () => {
    await expect(conditionProbe().attribute(cssLocator('#go'), 'data-testid')).resolves.toBe(
      'checkout',
    )
    await expect(conditionProbe().attribute(cssLocator('#go'), 'nope')).resolves.toBe('')
  })
})
