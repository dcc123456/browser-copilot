/**
 * Tests for the panel-window automation scope: window validation, the
 * connected-panel registry, and the pure visit-web trigger guard.
 *
 * Chrome is stubbed per tests/last-tab.spec.ts conventions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

type FakeWindow = { id: number; type: string }

function makeChrome(windows: FakeWindow[]) {
  const store = new Map<number, FakeWindow>(windows.map((w) => [w.id, w]))
  const removed: ((id: number) => void)[] = []
  return {
    store,
    removed,
    chrome: {
      windows: {
        get: vi.fn(async (id: number) => {
          const win = store.get(id)
          if (!win) throw new Error('No window with id: ' + id)
          return win
        }),
        onRemoved: { addListener: (fn: (id: number) => void) => removed.push(fn) },
      },
    },
  }
}

function fake(): ReturnType<typeof makeChrome> {
  return (globalThis as unknown as { __fake: ReturnType<typeof makeChrome> }).__fake
}

describe('automation scope', () => {
  let mod: typeof import('../src/background/automation-scope')

  beforeEach(async () => {
    vi.resetModules()
    const fakeChrome = makeChrome([
      { id: 1, type: 'normal' },
      { id: 2, type: 'popup' },
    ])
    ;(globalThis as unknown as { chrome: unknown }).chrome = fakeChrome.chrome
    ;(globalThis as unknown as { __fake: unknown }).__fake = fakeChrome
    mod = await import('../src/background/automation-scope')
  })

  afterEach(() => {
    delete (globalThis as Partial<{ chrome: unknown }>).chrome
    delete (globalThis as Partial<{ __fake: unknown }>).__fake
  })

  describe('normalScopeFromWindowId', () => {
    it('accepts a normal window', async () => {
      expect(await mod.normalScopeFromWindowId(1)).toEqual({ windowId: 1 })
    })

    it('rejects a popup window (standalone editor)', async () => {
      expect(await mod.normalScopeFromWindowId(2)).toBeUndefined()
    })

    it('rejects a missing window', async () => {
      expect(await mod.normalScopeFromWindowId(99)).toBeUndefined()
    })

    it('rejects an undefined window id', async () => {
      expect(await mod.normalScopeFromWindowId(undefined)).toBeUndefined()
    })
  })

  describe('panel window registry', () => {
    it('tracks windows by port with multi-port accounting', () => {
      const portA = { name: 'x' } as unknown as chrome.runtime.Port
      const portB = { name: 'x' } as unknown as chrome.runtime.Port
      expect(mod.hasPanelWindows()).toBe(false)

      mod.registerPanelWindow(1, portA)
      expect(mod.hasPanelWindows()).toBe(true)
      expect(mod.isPanelWindow(1)).toBe(true)
      expect(mod.isPanelWindow(2)).toBe(false)

      // A second port on the same window keeps the window registered after
      // the first port disconnects.
      mod.registerPanelWindow(1, portB)
      mod.unregisterPort(portA)
      expect(mod.isPanelWindow(1)).toBe(true)

      mod.unregisterPort(portB)
      expect(mod.hasPanelWindows()).toBe(false)
    })

    it('ignores non-numeric window ids', () => {
      mod.registerPanelWindow(undefined as unknown as number, {} as chrome.runtime.Port)
      expect(mod.hasPanelWindows()).toBe(false)
    })

    it('cleans up when a window closes', () => {
      const port = { name: 'x' } as unknown as chrome.runtime.Port
      mod.registerPanelWindow(1, port)
      mod.initScopeWindowCleanup()
      fake().removed.forEach((fn) => fn(1))
      expect(mod.hasPanelWindows()).toBe(false)
      expect(mod.isPanelWindow(1)).toBe(false)
    })
  })

  describe('latestPanelWindowId / currentPanelScope', () => {
    it('is undefined with no connected panel', () => {
      expect(mod.latestPanelWindowId()).toBeUndefined()
    })

    it('returns the most recently registered panel window', () => {
      const portA = { name: 'x' } as unknown as chrome.runtime.Port
      const portB = { name: 'x' } as unknown as chrome.runtime.Port
      mod.registerPanelWindow(1, portA)
      expect(mod.latestPanelWindowId()).toBe(1)
      mod.registerPanelWindow(2, portB)
      expect(mod.latestPanelWindowId()).toBe(2)
      // Re-registering the same window keeps it the latest without losing ports.
      mod.registerPanelWindow(2, portA)
      expect(mod.latestPanelWindowId()).toBe(2)
      // The re-homed port left window 1 empty — the entry must be retired.
      expect(mod.isPanelWindow(1)).toBe(false)
      // Dropping one port of window 2 keeps the window (portA is still there).
      mod.unregisterPort(portB)
      expect(mod.latestPanelWindowId()).toBe(2)
      mod.unregisterPort(portA)
      expect(mod.latestPanelWindowId()).toBeUndefined()
    })
  })

  describe('shouldTriggerVisitWeb', () => {
    it('is global when no panel window exists', () => {
      expect(mod.shouldTriggerVisitWeb(false, false)).toBe(true)
      expect(mod.shouldTriggerVisitWeb(false, true)).toBe(true)
    })

    it('restricts to panel windows once one exists', () => {
      expect(mod.shouldTriggerVisitWeb(true, true)).toBe(true)
      expect(mod.shouldTriggerVisitWeb(true, false)).toBe(false)
    })
  })
})
