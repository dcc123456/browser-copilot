/**
 * Tests for panel-window scoped tab resolution in the driver.
 *
 * The invariant under test: with a ScopeWindow, the driver resolves tabs, lists
 * tabs, opens tabs and navigates ONLY inside that window — never falling back
 * to another window, even when other windows hold perfectly injectable tabs.
 * Unscoped calls keep the legacy behaviour (last-focused window).
 *
 * Chrome is stubbed per tests/last-tab.spec.ts conventions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

interface FakeTab {
  id: number
  windowId: number
  url: string
  title?: string
  active?: boolean
}

interface FakeWindow {
  id: number
  type: string
}

let nextTabId = 100

interface Browser {
  tabs: Map<number, FakeTab>
  windows: Map<number, FakeWindow>
  lastFocusedWindowId: number
  calls: { update: unknown[]; create: unknown[]; remove: unknown[]; getAll: unknown[]; getLastFocused: number }
  listeners: Record<string, ((...args: unknown[]) => void)[]>
}

function makeBrowser(opts: {
  tabs: FakeTab[]
  windows: FakeWindow[]
  lastFocusedWindowId: number
}): Browser {
  const b: Browser = {
    tabs: new Map(opts.tabs.map((t) => [t.id, { ...t }])),
    windows: new Map(opts.windows.map((w) => [w.id, { ...w }])),
    lastFocusedWindowId: opts.lastFocusedWindowId,
    calls: { update: [], create: [], remove: [], getAll: [], getLastFocused: 0 },
    listeners: {},
  }
  const on = (name: string) => ({
    addListener: (fn: (...args: unknown[]) => void) => {
      ;(b.listeners[name] ??= []).push(fn)
    },
  })
  const toTab = (t: FakeTab): chrome.tabs.Tab =>
    ({ id: t.id, windowId: t.windowId, url: t.url, title: t.title ?? '', active: t.active === true }) as chrome.tabs.Tab

  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      onActivated: on('onActivated'),
      onUpdated: on('onUpdated'),
      onRemoved: on('onRemoved'),
      get: vi.fn(async (id: number) => {
        const t = b.tabs.get(id)
        if (!t) throw new Error('No tab with id: ' + id)
        return toTab(t)
      }),
      query: vi.fn(async (q: Record<string, unknown>) => {
        let list = [...b.tabs.values()]
        if (typeof q['windowId'] === 'number') list = list.filter((t) => t.windowId === q['windowId'])
        if (q['active'] === true) list = list.filter((t) => t.active === true)
        if (q['lastFocusedWindow'] === true || q['currentWindow'] === true) {
          list = list.filter((t) => t.windowId === b.lastFocusedWindowId)
        }
        return list.map(toTab)
      }),
      update: vi.fn(async (idOrProps: number | Record<string, unknown>, props?: Record<string, unknown>) => {
        b.calls.update.push([idOrProps, props])
        if (typeof idOrProps === 'number') {
          const t = b.tabs.get(idOrProps)
          if (t && props) Object.assign(t, props)
          return t ? toTab(t) : undefined
        }
        return undefined
      }),
      create: vi.fn(async (props: Record<string, unknown>) => {
        b.calls.create.push(props)
        const id = nextTabId++
        const tab: FakeTab = {
          id,
          windowId: typeof props['windowId'] === 'number' ? (props['windowId'] as number) : b.lastFocusedWindowId,
          url: typeof props['url'] === 'string' ? (props['url'] as string) : 'chrome://newtab/',
          active: true,
        }
        b.tabs.set(id, tab)
        return toTab(tab)
      }),
      remove: vi.fn(async (id: number) => {
        b.calls.remove.push(id)
        b.tabs.delete(id)
      }),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
    },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = b.windows.get(id)
        if (!w) throw new Error('No window with id: ' + id)
        return { id: w.id, type: w.type } as chrome.windows.Window
      }),
      getLastFocused: vi.fn(async (_opts?: unknown) => {
        b.calls.getLastFocused += 1
        const w = b.windows.get(b.lastFocusedWindowId)
        return w ? { id: w.id, type: w.type } : ({} as chrome.windows.Window)
      }),
      getAll: vi.fn(async (_opts?: unknown) => {
        b.calls.getAll.push(arguments)
        return [...b.windows.values()] as chrome.windows.Window[]
      }),
      onFocusChanged: on('onFocusChanged'),
      onRemoved: on('windows.onRemoved'),
    },
  }
  return b
}

function browser(): Browser {
  return (globalThis as unknown as { __browser: Browser }).__browser
}

/** Two normal windows; window 1 is the panel window, window 2 the user's own. */
function standardSetup(activeTab1Url = 'https://panel.example/page'): Browser {
  const b = makeBrowser({
    tabs: [
      { id: 1, windowId: 1, url: activeTab1Url, active: true, title: 'Panel' },
      { id: 2, windowId: 2, url: 'https://other.example/page', active: true, title: 'Other' },
    ],
    windows: [
      { id: 1, type: 'normal' },
      { id: 2, type: 'normal' },
    ],
    lastFocusedWindowId: 2, // the user is looking at the OTHER window
  })
  ;(globalThis as unknown as { __browser: unknown }).__browser = b
  return b
}

describe('driver panel-window scope', () => {
  let driver: typeof import('../src/background/driver')
  let lastTab: typeof import('../src/background/last-tab')

  beforeEach(async () => {
    vi.resetModules()
    nextTabId = 100
    standardSetup()
    const mod = await Promise.all([
      import('../src/background/driver'),
      import('../src/background/last-tab'),
    ])
    driver = mod[0]
    lastTab = mod[1]
    lastTab.initLastTabTracker()
  })

  afterEach(() => {
    delete (globalThis as Partial<{ chrome: unknown }>).chrome
    delete (globalThis as Partial<{ __browser: unknown }>).__browser
  })

  const scope = { windowId: 1 }

  it('newTab creates inside the scoped window; unscoped keeps legacy', async () => {
    const b = browser()
    const created = await driver.newTab('https://new.example/', scope)
    expect(created.id).toBe(100)
    expect(b.calls.create[0]).toMatchObject({ url: 'https://new.example/', windowId: 1 })

    await driver.newTab('https://new2.example/')
    expect(b.calls.create[1]).not.toHaveProperty('windowId')
  })

  it('listTabs/switchTab only see the scoped window', async () => {
    const b = browser()
    const scoped = await driver.listTabs(scope)
    expect(scoped.map((t) => t.id)).toEqual([1])

    const legacy = await driver.listTabs()
    expect(legacy.map((t) => t.id)).toEqual([2]) // currentWindow = last focused = 2

    const switched = await driver.switchTab(0, scope)
    expect(switched.id).toBe(1)
    expect(b.calls.update[0]).toEqual([1, { active: true }])
  })

  it('updateActiveTabUrl navigates the scoped window active tab; unscoped keeps tabs.update({url})', async () => {
    const b = browser()
    await driver.updateActiveTabUrl('https://nav.example/', scope)
    expect(b.calls.update[0]).toEqual([1, { url: 'https://nav.example/' }])

    await driver.updateActiveTabUrl('https://nav2.example/')
    expect(b.calls.update[1]![0]).toEqual({ url: 'https://nav2.example/' })
  })

  it('scoped resolution returns the scoped window active tab without touching other windows', async () => {
    const b = browser()
    const tab = await driver.resolveAutomationTab(undefined, scope)
    expect(tab?.id).toBe(1)
    // The legacy cross-window fallbacks must never run for a scoped call.
    expect(b.calls.getAll).toHaveLength(0)
    expect(b.calls.getLastFocused).toBe(0)
  })

  it('scoped resolution never leaks a cached tab from an unscoped run', async () => {
    const unscoped = await driver.resolveAutomationTab()
    expect(unscoped?.id).toBe(2) // legacy chain: focused window 2's tab

    const scoped = await driver.resolveAutomationTab(undefined, scope)
    expect(scoped?.id).toBe(1) // NOT the cached window-2 tab
  })

  it('scoped resolution uses the remembered tab of the same window when the active tab is chrome://', async () => {
    browser().tabs.get(1)!.url = 'chrome://newtab/'
    // Seed the last-tab tracker with a remembered http(s) tab in window 1.
    const remembered = { id: 5, windowId: 1, url: 'https://remembered.example/', active: false }
    browser().tabs.set(5, remembered)
    browser().listeners['onUpdated']!.forEach((fn) =>
      fn(5, { status: 'complete' }, remembered as chrome.tabs.Tab),
    )
    for (let i = 0; i < 5; i++) await Promise.resolve()

    const tab = await driver.resolveAutomationTab(undefined, scope)
    expect(tab?.id).toBe(5)
  })

  it('scoped resolution returns undefined instead of crossing into another window', async () => {
    browser().tabs.get(1)!.url = 'chrome://newtab/' // panel window: nothing injectable
    const tab = await driver.resolveAutomationTab(undefined, scope)
    expect(tab).toBeUndefined()
  })

  it('a scope window that no longer exists degrades to the legacy global chain', async () => {
    const tab = await driver.resolveAutomationTab(undefined, { windowId: 9 })
    expect(tab?.id).toBe(2) // legacy: focused window 2
  })
})
