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
  getPickedElement,
  rememberPickedElement,
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

function stored(): Record<string, Record<string, unknown>> {
  return (fake.session.get(SESSION_KEY) ?? {}) as Record<string, Record<string, unknown>>
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

describe('rememberPickedElement / getPickedElement', () => {
  it('round-trips a pick through storage.session', async () => {
    await rememberPickedElement(7, picked)

    const read = await getPickedElement(7)
    expect(read).toMatchObject({ selector: '#buy', tag: 'button', url: picked.url })
    expect(stored()).toHaveProperty('7')
  })

  it('keeps tabs apart and overwrites a tab with its newest pick', async () => {
    await rememberPickedElement(1, picked)
    await rememberPickedElement(2, { ...picked, selector: '#sell', url: 'https://sell.test/' })
    await rememberPickedElement(1, { ...picked, selector: '#cart', pickedAt: picked.pickedAt + 1 })

    expect((await getPickedElement(1))?.selector).toBe('#cart')
    expect((await getPickedElement(2))?.selector).toBe('#sell')
    expect(await getPickedElement(3)).toBeUndefined()
  })

  it('serializes concurrent writes instead of losing one', async () => {
    await Promise.all([
      rememberPickedElement(1, picked),
      rememberPickedElement(2, { ...picked, selector: '#two' }),
    ])

    expect((await getPickedElement(1))?.selector).toBe('#buy')
    expect((await getPickedElement(2))?.selector).toBe('#two')
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
    expect(await getPickedElement(1)).toBeUndefined()
  })

  it('is a no-op when chrome.storage.session is unavailable', async () => {
    vi.stubGlobal('chrome', {})

    await expect(rememberPickedElement(1, picked)).resolves.toBeUndefined()
    expect(await getPickedElement(1)).toBeUndefined()
  })
})
