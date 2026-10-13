/**
 * Tests for the panel-window automation scope: window validation, the
 * connected-panel registry, and the pure visit-web trigger guard.
 *
 * Chrome is stubbed per tests/last-tab.spec.ts conventions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

type FakeWindow = { id: number; type: string }

function makeChrome(windows: FakeWindow[]) {
  const store = new Map<number, FakeWindow>(windows.map((w) => [w.id, { ...w }]))
  const removed: ((id: number) => void)[] = []
  const created: Record<string, unknown>[] = []
  const removeCalls: number[] = []
  const sessionStore: Record<string, unknown> = {}
  let nextWindowId = 100
  return {
    store,
    removed,
    created,
    removeCalls,
    sessionStore,
    chrome: {
      windows: {
        get: vi.fn(async (id: number) => {
          const win = store.get(id)
          if (!win) throw new Error('No window with id: ' + id)
          return win
        }),
        create: vi.fn(async (props: Record<string, unknown>) => {
          created.push(props)
          const id = nextWindowId++
          store.set(id, { id, type: 'normal' })
          return { id }
        }),
        remove: vi.fn(async (id: number) => {
          removeCalls.push(id)
          store.delete(id)
          // Chrome broadcasts the close, so the registered listeners run too.
          removed.forEach((fn) => fn(id))
        }),
        onRemoved: {
          addListener: (fn: (id: number) => void) => {
            removed.push(fn)
          },
        },
      },
      storage: {
        session: {
          get: vi.fn(async (key: string) =>
            key in sessionStore ? { [key]: sessionStore[key] } : {},
          ),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(sessionStore, obj)
          }),
        },
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

  describe('latestPanelWindowId / currentPluginScope', () => {
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

  describe('plugin windows (connected panels ∪ minimized panels)', () => {
    it('counts a minimized window as a plugin window', async () => {
      const minimize: typeof import('../src/background/panel-minimize') =
        await import('../src/background/panel-minimize')
      expect(mod.hasPluginWindows()).toBe(false)
      expect(mod.isPluginWindow(1)).toBe(false)
      expect(mod.latestPluginWindowId()).toBeUndefined()

      minimize.minimizeWindow(1)
      expect(mod.hasPluginWindows()).toBe(true)
      expect(mod.isPluginWindow(1)).toBe(true)
      expect(mod.isPluginWindow(2)).toBe(false)
      expect(mod.latestPluginWindowId()).toBe(1)

      // A connected panel outranks a minimized window…
      const port = { name: 'x' } as unknown as chrome.runtime.Port
      mod.registerPanelWindow(2, port)
      expect(mod.latestPluginWindowId()).toBe(2)
      // …and once the panel disconnects, the minimized window remains.
      mod.unregisterPort(port)
      expect(mod.latestPluginWindowId()).toBe(1)

      minimize.expandWindow(1)
      expect(mod.hasPluginWindows()).toBe(false)
    })
  })

  describe('run-owned windows', () => {
    it('creates an unfocused, cascaded window and records the ownership', async () => {
      const windowId = await mod.createRunWindow('run-a', 1)
      expect(typeof windowId).toBe('number')
      expect(mod.isRunOwnedWindow(windowId)).toBe(true)
      // A window the extension did not create is never run-owned.
      expect(mod.isRunOwnedWindow(1)).toBe(false)
      // ...and a run window is never a plugin window, so no later run resolves into it.
      expect(mod.isPluginWindow(windowId!)).toBe(false)

      const props = fake().created[0]!
      expect(props['focused']).toBe(false)
      // tier 1 is offset from tier 0 so no title bar is fully covered.
      expect(props['left']).toBe(80 + 56)
      expect(props['top']).toBe(60 + 44)

      expect(fake().sessionStore['bc:runOwnedWindows']).toEqual([
        { windowId, runId: 'run-a', closed: false },
      ])
    })

    it('keeps the ownership record when the user closes the window mid-run', async () => {
      const windowId = await mod.createRunWindow('run-a', 0)
      mod.initScopeWindowCleanup()
      fake().removed.forEach((fn) => fn(windowId!))

      // The run must still be recognised as owning it, or the driver would fall
      // back to the global tab chain and act inside the user's window.
      expect(mod.isRunOwnedWindow(windowId)).toBe(true)
      expect(mod.listRunOwnedWindows()).toEqual([{ windowId, runId: 'run-a', closed: true }])
    })

    it('prunes, closes and forgets, and is idempotent', async () => {
      const windowId = await mod.createRunWindow('run-a', 0)
      const pruned: number[] = []
      mod.setRunWindowPruner((id) => pruned.push(id))

      await mod.closeRunWindow(windowId!)
      expect(pruned).toEqual([windowId])
      expect(fake().removeCalls).toEqual([windowId])
      expect(mod.isRunOwnedWindow(windowId)).toBe(false)
      expect(fake().sessionStore['bc:runOwnedWindows']).toEqual([])

      // The run's finally may fire after the user already closed the window.
      await mod.closeRunWindow(windowId!)
      expect(fake().removeCalls).toEqual([windowId])
      mod.setRunWindowPruner(null)
    })

    it('closes a window whose run died and keeps a live run owned', async () => {
      const live = await mod.createRunWindow('run-live', 0)
      const dead = await mod.createRunWindow('run-dead', 1)
      // A fresh worker: only the storage.session mirror survived.
      vi.resetModules()
      mod = await import('../src/background/automation-scope')

      const closed = await mod.reclaimOrphanRunWindows((runId) => runId === 'run-live')
      expect(closed).toEqual([dead])
      expect(fake().store.has(dead!)).toBe(false)
      expect(fake().store.has(live!)).toBe(true)
      // Re-adopted, so the live run can still close its own window later.
      expect(mod.isRunOwnedWindow(live)).toBe(true)
      expect(mod.isRunOwnedWindow(dead)).toBe(false)
    })

    it('drops mirror entries whose window is already gone', async () => {
      fake().sessionStore['bc:runOwnedWindows'] = [
        { windowId: 900, runId: 'run-gone', closed: false },
      ]
      const closed = await mod.reclaimOrphanRunWindows(() => false)
      expect(closed).toEqual([])
      expect(fake().removeCalls).toEqual([])
    })

    it('does nothing without chrome', async () => {
      delete (globalThis as Partial<{ chrome: unknown }>).chrome
      expect(await mod.createRunWindow('run-a', 0)).toBeUndefined()
      expect(await mod.reclaimOrphanRunWindows(() => false)).toEqual([])
    })
  })
})
