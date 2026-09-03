/**
 * Tests for the last-injectable-tab tracker, which backs the driver's tab
 * resolution fallback when a workflow is launched from the standalone editor
 * popup (a chrome-extension:// window none of the active-tab queries surface).
 *
 * The tracker listens to chrome.tabs events; here we exercise remember/forget
 * logic indirectly through the events with a stubbed `chrome` global, and
 * assert getLastInjectableTab validates and prefers the right tab.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

interface FakeTab {
  id: number
  windowId: number
  url: string
}

/** Flush several microtask ticks so `chrome.tabs.get(...).then(...)` resolves. */
const tick = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

function makeChrome(tabs: FakeTab[]) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const store = new Map<number, FakeTab>(tabs.map((t) => [t.id, t]))
  const on = (name: string) => ({
    addListener: (fn: (...args: unknown[]) => void) => {
      ;(listeners[name] ??= []).push(fn)
    },
  })
  return {
    listeners,
    store,
    chrome: {
      tabs: {
        onActivated: on('onActivated'),
        onUpdated: on('onUpdated'),
        onRemoved: on('onRemoved'),
        get: vi.fn(async (id: number) => {
          const tab = store.get(id)
          if (!tab) throw new Error('no tab')
          return tab
        }),
        query: vi.fn(async () => tabs.filter((t) => store.has(t.id))),
      },
    },
  }
}

describe('last injectable tab tracker', () => {
  let mod: typeof import('../src/background/last-tab')

  beforeEach(async () => {
    vi.resetModules()
    const fake = makeChrome([])
    ;(globalThis as unknown as { chrome: unknown }).chrome = fake.chrome
    mod = await import('../src/background/last-tab')
    mod.initLastTabTracker()
    ;(globalThis as unknown as { __fake: unknown }).__fake = fake
  })

  afterEach(() => {
    delete (globalThis as Partial<{ chrome: unknown }>).chrome
  })

  function fake(): {
    listeners: Record<string, ((...args: unknown[]) => void)[]>
    store: Map<number, FakeTab>
  } {
    return (globalThis as unknown as { __fake: ReturnType<typeof makeChrome> }).__fake
  }

  it('ignores extension/non-http tabs and remembers http(s) ones', async () => {
    const { listeners, store } = fake()
    store.set(1, { id: 1, windowId: 1, url: 'chrome-extension://abc/editor.html' })
    store.set(2, { id: 2, windowId: 2, url: 'https://example.com/' })
    listeners['onActivated']!.forEach((fn) => fn({ tabId: 1 }))
    listeners['onActivated']!.forEach((fn) => fn({ tabId: 2 }))
    await tick()

    const got = await mod.getLastInjectableTab()
    expect(got?.id).toBe(2)
  })

  it('forgets a closed tab', async () => {
    const { listeners, store } = fake()
    store.set(5, { id: 5, windowId: 1, url: 'https://news.test/' })
    listeners['onUpdated']!.forEach((fn) => fn(5, { status: 'complete' }, store.get(5)!))
    await tick()
    expect((await mod.getLastInjectableTab())?.id).toBe(5)

    store.delete(5)
    listeners['onRemoved']!.forEach((fn) => fn(5, { windowId: 1, isWindowClosing: false }))
    await tick()
    expect(await mod.getLastInjectableTab()).toBeUndefined()
  })

  it('returns undefined when no injectable tab is remembered', async () => {
    expect(await mod.getLastInjectableTab()).toBeUndefined()
  })

  it('onlyWindowId restricts candidates to that window', async () => {
    const { listeners, store } = fake()
    store.set(10, { id: 10, windowId: 1, url: 'https://older.test/' })
    store.set(11, { id: 11, windowId: 1, url: 'https://newer.test/' })
    store.set(20, { id: 20, windowId: 2, url: 'https://other-window.test/' })
    listeners['onUpdated']!.forEach((fn) => fn(10, { status: 'complete' }, store.get(10)!))
    await tick()
    listeners['onUpdated']!.forEach((fn) => fn(11, { status: 'complete' }, store.get(11)!))
    await tick()
    listeners['onUpdated']!.forEach((fn) => fn(20, { status: 'complete' }, store.get(20)!))
    await tick()

    // Unscoped prefers the most recent across every window.
    expect((await mod.getLastInjectableTab())?.id).toBe(20)
    // Scoped to window 1: window 2's tab must never surface.
    expect((await mod.getLastInjectableTab(undefined, 1))?.id).toBe(11)
    expect((await mod.getLastInjectableTab(undefined, 2))?.id).toBe(20)
    expect(await mod.getLastInjectableTab(undefined, 7)).toBeUndefined()
  })
})
