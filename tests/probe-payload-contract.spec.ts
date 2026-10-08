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
import type { Op, OpResult, Target } from '../src/lib/ops'
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
vi.mock('../src/lib/workflow/blocks/palette', () => ({
  BLOCK_BY_ID: new Map(),
  PALETTE_BLOCKS: [],
}))

const { createDriverReadinessProbe } =
  await import('../src/background/workflow-engine/run-workflow')
const { createDriverConditionProbe } =
  await import('../src/background/workflow-engine/condition-runtime')
const { targetFrom } = await import('../src/background/workflow-engine/executors')

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
  return (
    requirement: ReadinessRequirement,
    nodeSelector: string,
    nodeTarget?: ReturnType<typeof targetFrom>,
  ) => probe(requirement, nodeSelector, signal, nodeTarget)
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

  it('`present` sees a text-located node (regression: it had nothing to probe)', async () => {
    // `findBy:'text'` keeps the literal text in `selector` and leaves the node
    // with no CSS of its own. A wait that looked only at the flat CSS selector
    // therefore had nothing to probe, and timed out a step whose action worked.
    const requirement: ReadinessRequirement = { state: 'present' }
    const params = { findBy: 'text', selector: '买' }

    await expect(readinessProbe()(requirement, '', targetFrom(params))).resolves.toMatchObject({
      satisfied: true,
    })
    // Counterfactual: the same node through the old narrower view stays blind.
    await expect(readinessProbe()(requirement, '')).resolves.toMatchObject({
      satisfied: false,
      detail: '没有可探测的定位',
    })
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

describe('`value-committed` reads the control the way the step wrote it', () => {
  // A generated graph carries its own readiness contract, and the generated
  // fill is compared against the LIVE control by this probe. Every case below is
  // a step that worked in the browser and was then failed by its own gate —
  // which sends the repair ladder after a node that needs no repair.
  const FORM = `
    <input id="title" value="手搓脚本太累 3步搞定浏览器自动化" />
    <div contenteditable="true" id="body"><p>手搓脚本太累</p><p>3步搞定浏览器自动化</p></div>
    <input type="checkbox" id="agree" checked />
    <input type="file" id="cover" style="display:none" />
  `

  beforeEach(() => {
    document.body.innerHTML = FORM
    useRealKernel()
  })

  it('accepts text the DOM reflowed into blocks', async () => {
    // The write was one string with newlines; the contenteditable reads back as
    // `textContent`, which joins the paragraphs with NO separator.
    const probe = readinessProbe()
    await expect(
      probe({ state: 'value-committed', value: '手搓脚本太累\n\n3步搞定浏览器自动化' }, '#body'),
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('still refuses a control that holds different text', async () => {
    const outcome = await readinessProbe()(
      { state: 'value-committed', value: '标题被清空了' },
      '#title',
    )
    expect(outcome.satisfied).toBe(false)
    expect(outcome.detail).toContain('尚未提交')
  })

  it('reads a checkbox, which the kernel reports as a boolean, not a string', async () => {
    // `get_value` on a checkbox is `element.checked`. Reading only strings made
    // this gate answer "cannot read the control" forever, for a step that flips
    // the box every time.
    const probe = readinessProbe()
    await expect(
      probe({ state: 'value-committed', value: 'true' }, '#agree'),
    ).resolves.toMatchObject({ satisfied: true })
    const unchecked = await probe({ state: 'value-committed', value: 'false' }, '#agree')
    expect(unchecked.satisfied).toBe(false)
  })

  it('a hidden file input still satisfies a `present` gate', async () => {
    // The upload default gate is `present` for exactly this reason: the page
    // styles a drop zone and keeps the input display:none, so a `visible` wait
    // polls a condition that is false forever.
    await expect(readinessProbe()({ state: 'present' }, '#cover')).resolves.toMatchObject({
      satisfied: true,
    })
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
    harness.fn = async () =>
      runOp({
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

describe('a condition recorded as the node\'s own Target is still observable', () => {
  // Generation writes `condition.target` as the rich `{ primary, fallbacks }` the
  // snapshot produced, not as a semantic locator. Read as a locator it carries no
  // identity fields at all, so `elementExists` answered false forever — an
  // unverifiable step, which is what sank every repair candidate for a graph
  // whose clicks all worked.
  beforeEach(() => {
    document.body.innerHTML = PAGE
    useRealKernel()
  })

  it('resolves a recorded css chain through the real kernel', async () => {
    const target: Target = { fallbacks: [], primary: { how: 'css', value: '#go' } }
    await expect(conditionProbe().exists(target)).resolves.toBe(true)
    await expect(conditionProbe().text(target)).resolves.toBe('买')
  })

  it('walks the whole recorded chain: a dead primary still finds the fallback', async () => {
    const target: Target = {
      primary: { how: 'css', value: '#gone-since-last-visit' },
      fallbacks: [{ how: 'css', value: '#go' }],
    }
    await expect(conditionProbe().exists(target)).resolves.toBe(true)
  })

  it('keeps an unobservable spec instead of dropping it: identity-only matching read the element as absent', async () => {
    const captured: Op[] = []
    harness.fn = async (op) => {
      captured.push(op)
      return { ok: true, found: true, data: 1, frameUrl: 'https://example.test/page', isTopFrame: true }
    }
    const closedShadowTarget: Target = {
      label: '暂存离开',
      fallbacks: [],
      primary: {
        how: 'cdp-shadow',
        value: '暂存离开',
        role: 'button',
        tag: 'button',
        shadowHosts: ['xhs-publish-btn'],
        closedShadow: true,
      },
    }
    await expect(conditionProbe().exists(closedShadowTarget)).resolves.toBe(true)
    expect(captured[0]?.target).toEqual({
      primary: closedShadowTarget.primary,
      fallbacks: [],
    })
  })

  it('an empty spec chain is not a probe: it reports absent, never matches everything', async () => {
    const captured: Op[] = []
    harness.fn = async (op) => {
      captured.push(op)
      return { ok: true, found: true, data: 9, frameUrl: 'https://example.test/page', isTopFrame: true }
    }
    const empty: Target = { primary: { how: 'role', value: '' }, fallbacks: [] }
    await expect(conditionProbe().exists(empty)).resolves.toBe(false)
    await expect(conditionProbe().count({} as SemanticLocator)).resolves.toBe(0)
    expect(captured).toHaveLength(0)
  })
})
