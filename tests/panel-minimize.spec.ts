/**
 * Tests for the minimized-plugin state (see background/panel-minimize.ts).
 *
 * The invariant: a minimized window counts as "plugin open" for unattended
 * scoping, the mark survives a worker restart via chrome.storage.session,
 * and it is dropped when the window closes or the plugin expands.
 *
 * Chrome is stubbed per tests/last-tab.spec.ts conventions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

function makeChrome() {
  const session = new Map<string, unknown>()
  const windows = new Map<number, { id: number; type: string }>([
    [1, { id: 1, type: 'normal' }],
    [2, { id: 2, type: 'normal' }],
    [3, { id: 3, type: 'normal' }],
  ])
  const removed: ((id: number) => void)[] = []
  const chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v)
        }),
      },
    },
    windows: {
      get: vi.fn(async (id: number) => {
        const win = windows.get(id)
        if (!win) throw new Error('No window with id: ' + id)
        return win
      }),
      onRemoved: { addListener: (fn: (id: number) => void) => removed.push(fn) },
    },
  }
  return { session, windows, removed, chrome }
}

function fake(): ReturnType<typeof makeChrome> {
  return (globalThis as unknown as { __fake: ReturnType<typeof makeChrome> }).__fake
}

describe('panel minimize state', () => {
  let mod: typeof import('../src/background/panel-minimize')

  beforeEach(async () => {
    vi.resetModules()
    const fakeChrome = makeChrome()
    ;(globalThis as unknown as { chrome: unknown }).chrome = fakeChrome.chrome
    ;(globalThis as unknown as { __fake: unknown }).__fake = fakeChrome
    mod = await import('../src/background/panel-minimize')
  })

  afterEach(() => {
    delete (globalThis as Partial<{ chrome: unknown }>).chrome
    delete (globalThis as Partial<{ __fake: unknown }>).__fake
  })

  it('marks, queries and clears minimized windows', () => {
    expect(mod.isMinimized(1)).toBe(false)
    expect(mod.listMinimizedWindowIds()).toEqual([])

    mod.minimizeWindow(1)
    mod.minimizeWindow(3)
    expect(mod.isMinimized(1)).toBe(true)
    expect(mod.isMinimized(3)).toBe(true)
    expect(mod.isMinimized(2)).toBe(false)
    // Insertion order: oldest minimization first.
    expect(mod.listMinimizedWindowIds()).toEqual([1, 3])

    mod.expandWindow(1)
    expect(mod.isMinimized(1)).toBe(false)
    expect(mod.listMinimizedWindowIds()).toEqual([3])

    // Expanding a window that was never minimized is a no-op.
    expect(() => mod.expandWindow(2)).not.toThrow()
  })

  it('re-minimizing keeps the original order position', () => {
    mod.minimizeWindow(1)
    mod.minimizeWindow(3)
    mod.minimizeWindow(1)
    expect(mod.listMinimizedWindowIds()).toEqual([1, 3])
  })

  it('ignores non-numeric window ids', () => {
    mod.minimizeWindow(undefined as unknown as number)
    expect(mod.listMinimizedWindowIds()).toEqual([])
  })

  it('mirrors marks into chrome.storage.session', async () => {
    mod.minimizeWindow(1)
    mod.minimizeWindow(2)
    // set() is invoked synchronously by minimizeWindow (promise internally).
    await Promise.resolve()
    expect(fake().session.get('minimizedWindows')).toEqual([1, 2])

    mod.expandWindow(1)
    await Promise.resolve()
    expect(fake().session.get('minimizedWindows')).toEqual([2])
  })

  it('restores marks from session storage after a worker restart', async () => {
    mod.minimizeWindow(1)
    mod.minimizeWindow(3)
    await Promise.resolve()
    expect(fake().session.get('minimizedWindows')).toEqual([1, 3])

    // Simulate a fresh worker: reset modules, keep the session store.
    vi.resetModules()
    const restored: typeof import('../src/background/panel-minimize') = await import(
      '../src/background/panel-minimize'
    )
    expect(restored.isMinimized(1)).toBe(false) // not yet loaded
    restored.initPanelMinimize()
    await vi.waitFor(() => {
      expect(restored.isMinimized(1)).toBe(true)
    })
    expect(restored.isMinimized(3)).toBe(true)
    expect(restored.listMinimizedWindowIds()).toHaveLength(2)
  })

  it('drops marks for windows that closed while the worker was down', async () => {
    mod.minimizeWindow(1)
    await Promise.resolve()
    fake().windows.delete(1) // window closed off-stage

    vi.resetModules()
    const restored: typeof import('../src/background/panel-minimize') = await import(
      '../src/background/panel-minimize'
    )
    restored.initPanelMinimize()
    await vi.waitFor(() => {
      expect(restored.isMinimized(1)).toBe(false)
    })
  })

  it('clears the mark when the window closes during a session', async () => {
    mod.initPanelMinimize()
    mod.minimizeWindow(2)
    expect(mod.isMinimized(2)).toBe(true)

    fake().removed.forEach((fn) => fn(2))
    expect(mod.isMinimized(2)).toBe(false)
  })

  it('whenRestoreSettled resolves only after the session restore is applied', async () => {
    mod.minimizeWindow(1)
    await Promise.resolve()
    expect(fake().session.get('minimizedWindows')).toEqual([1])

    // Fresh worker: the status answer must observe the restored mark, not
    // the pre-restore empty map.
    vi.resetModules()
    const restored: typeof import('../src/background/panel-minimize') = await import(
      '../src/background/panel-minimize'
    )
    expect(restored.isMinimized(1)).toBe(false)
    restored.initPanelMinimize()
    await restored.whenRestoreSettled()
    expect(restored.isMinimized(1)).toBe(true)
  })
})
