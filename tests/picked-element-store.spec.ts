/**
 * The picked-element store behind `read_selected_element`.
 *
 * What must hold: a pick survives a worker restart via chrome.storage.session,
 * picks are scoped per tab, the worker re-bounds everything a content script
 * sends (it is the trust boundary), and the map cannot grow without limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPickedElementWritesForTests,
  getPickedElements,
  rememberPickedElement,
  rememberPickedElements,
  sanitizePickedElement,
} from '../src/background/element-selection-store'

const SESSION_KEY = 'pickedElements'

function makeChrome() {
  const session = new Map<string, unknown>()
  return {
    session,
    chrome: {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) session.set(key, value)
          }),
        },
      },
    },
  }
}

function stored(): Record<string, unknown> {
  return (fake.session.get(SESSION_KEY) ?? {}) as Record<string, unknown>
}

let fake: ReturnType<typeof makeChrome>

const picked = {
  selector: '#buy',
  tag: 'BUTTON',
  id: 'buy',
  classes: ['cta'],
  text: 'Buy',
  html: '<button id="buy" class="cta">Buy</button>',
  url: 'https://shop.test/',
  title: 'Shop',
  pickedAt: 1_700_000_000_000,
}

const firstPickedElement = async (tabId: number) => (await getPickedElements(tabId))[0]

beforeEach(() => {
  fake = makeChrome()
  vi.stubGlobal('chrome', fake.chrome)
  _resetPickedElementWritesForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sanitizePickedElement', () => {
  it('lowercases the tag and keeps the identifying fields', () => {
    expect(sanitizePickedElement(picked)).toEqual({
      selector: '#buy',
      tag: 'button',
      id: 'buy',
      classes: ['cta'],
      text: 'Buy',
      html: picked.html,
      url: picked.url,
      title: picked.title,
      pickedAt: picked.pickedAt,
    })
  })

  it('needs a selector, a tag and a url — otherwise the record is useless', () => {
    expect(sanitizePickedElement({ ...picked, selector: '  ' })).toBeUndefined()
    expect(sanitizePickedElement({ ...picked, tag: '' })).toBeUndefined()
    expect(sanitizePickedElement({ ...picked, url: '' })).toBeUndefined()
    expect(sanitizePickedElement(null)).toBeUndefined()
    expect(sanitizePickedElement('nope')).toBeUndefined()
  })

  it('caps text, html and title; flags a truncated html', () => {
    const huge = sanitizePickedElement({
      ...picked,
      text: 't'.repeat(5000),
      html: 'h'.repeat(50_000),
      title: 'x'.repeat(1000),
    })!
    expect(huge.text).toHaveLength(2000)
    expect(huge.html).toHaveLength(20_000)
    expect(huge.htmlTruncated).toBe(true)
    expect(huge.title).toHaveLength(300)
  })

  it('caps a pathological URL instead of trusting the page', () => {
    const record = sanitizePickedElement({
      ...picked,
      url: `https://shop.test/?q=${'x'.repeat(10_000)}`,
    })!
    expect(record.url).toHaveLength(2000)
  })

  it('drops blank classes and caps their count and length', () => {
    const record = sanitizePickedElement({
      ...picked,
      classes: ['a', '', 42, 'b'.repeat(200), ...Array.from({ length: 20 }, (_, i) => `c${i}`)],
    })!
    expect(record.classes).toHaveLength(12)
    expect(record.classes?.[0]).toBe('a')
    expect(record.classes?.[1]).toBe('b'.repeat(80))
  })

  it('replaces a non-finite pickedAt with the supplied clock', () => {
    expect(sanitizePickedElement({ ...picked, pickedAt: Number.NaN }, 99)?.pickedAt).toBe(99)
    expect(sanitizePickedElement({ ...picked, pickedAt: 'yesterday' }, 99)?.pickedAt).toBe(99)
  })
})

describe('rememberPickedElement / firstPickedElement', () => {
  it('round-trips a pick through storage.session', async () => {
    await rememberPickedElement(7, picked)

    const read = await firstPickedElement(7)
    expect(read).toMatchObject({ selector: '#buy', tag: 'button', url: picked.url })
    expect(stored()).toHaveProperty('7')
  })

  it('keeps tabs apart and overwrites a tab with its newest pick', async () => {
    await rememberPickedElement(1, picked)
    await rememberPickedElement(2, { ...picked, selector: '#sell', url: 'https://sell.test/' })
    await rememberPickedElement(1, { ...picked, selector: '#cart', pickedAt: picked.pickedAt + 1 })

    expect((await firstPickedElement(1))?.selector).toBe('#cart')
    expect((await firstPickedElement(2))?.selector).toBe('#sell')
    expect(await firstPickedElement(3)).toBeUndefined()
  })

  it('serializes concurrent writes instead of losing one', async () => {
    await Promise.all([
      rememberPickedElement(1, picked),
      rememberPickedElement(2, { ...picked, selector: '#two' }),
    ])

    expect((await firstPickedElement(1))?.selector).toBe('#buy')
    expect((await firstPickedElement(2))?.selector).toBe('#two')
  })

  it('drops the oldest record past the tab cap', async () => {
    for (let tabId = 1; tabId <= 21; tabId += 1) {
      await rememberPickedElement(tabId, { ...picked, pickedAt: picked.pickedAt + tabId })
    }

    const keys = Object.keys(stored())
    expect(keys).toHaveLength(20)
    expect(keys).not.toContain('1')
    expect(keys).toContain('21')
  })

  it('ignores an invalid payload and a non-numeric tab id', async () => {
    await rememberPickedElement(1, { selector: '' })
    await rememberPickedElement(Number.NaN, picked)

    expect(stored()).toEqual({})
    expect(await firstPickedElement(1)).toBeUndefined()
  })

  it('is a no-op when chrome.storage.session is unavailable', async () => {
    vi.stubGlobal('chrome', {})

    await expect(rememberPickedElement(1, picked)).resolves.toBeUndefined()
    expect(await firstPickedElement(1)).toBeUndefined()
  })
})

describe('rememberPickedElements / getPickedElements', () => {
  it('round-trips the ordered batch and replaces it on every update', async () => {
    await rememberPickedElements(7, [picked, { ...picked, selector: '#cart', text: 'Cart' }])
    expect((await getPickedElements(7)).map((element) => element.selector)).toEqual([
      '#buy',
      '#cart',
    ])

    await rememberPickedElements(7, [{ ...picked, selector: '#sell' }])
    expect((await getPickedElements(7)).map((element) => element.selector)).toEqual(['#sell'])
    expect((await firstPickedElement(7))?.selector).toBe('#sell')
  })

  it('clears a tab when the last selected element is toggled off', async () => {
    await rememberPickedElements(7, [picked])
    await rememberPickedElements(7, [])

    expect(await getPickedElements(7)).toEqual([])
    expect(stored()).toEqual({})
  })

  it('caps each batch and filters invalid records at the worker boundary', async () => {
    const batch: unknown[] = Array.from({ length: 12 }, (_, index) => ({
      ...picked,
      selector: `#item-${index}`,
    }))
    batch[2] = { selector: '' }

    await rememberPickedElements(7, batch)

    const elements = await getPickedElements(7)
    expect(elements).toHaveLength(9)
    expect(elements.some((element) => element.selector === '#item-2')).toBe(false)
    expect(elements[0]?.selector).toBe('#item-0')
  })

  it('reads a pre-multi-select session record as a one-element batch', async () => {
    fake.session.set(SESSION_KEY, { 7: picked })

    expect(await getPickedElements(7)).toEqual([picked])
    expect(await firstPickedElement(7)).toEqual(picked)
  })
})
