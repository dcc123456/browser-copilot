/**
 * Tests for the unattended window policy (see background/window-policy.ts).
 *
 * The pure truth table of `resolveUnattendedWindow` is the heart: unattended
 * runs may only target plugin windows (panel connected or minimized), the
 * default policy is "latest plugin window", "fixed" falls back inside the
 * operable set when its window is gone, and "ask" only asks when there is a
 * real choice.
 *
 * Chrome is stubbed per tests/last-tab.spec.ts conventions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { WindowChoice } from '../src/lib/messages'

function win(
  windowId: number,
  flags: Partial<Pick<WindowChoice, 'isPanel' | 'isMinimized'>> = {},
): WindowChoice {
  return { windowId, title: `w${windowId}`, isPanel: false, isMinimized: false, ...flags }
}

describe('resolveUnattendedWindow (pure policy)', () => {
  let policy: typeof import('../src/background/window-policy')

  beforeEach(async () => {
    vi.resetModules()
    policy = await import('../src/background/window-policy')
  })

  afterEach(() => {
    policy._resetWindowPolicyForTests()
  })

  it('yields none when the plugin is closed everywhere', () => {
    const windows = [win(1), win(2, { isPanel: false })]
    for (const p of ['latest', 'ask', 'fixed'] as const) {
      expect(policy.resolveUnattendedWindow(p, windows, undefined, 1)).toEqual({ kind: 'none' })
    }
  })

  it('latest picks the most recently used plugin window', () => {
    const windows = [win(1, { isMinimized: true }), win(2, { isPanel: true })]
    expect(
      policy.resolveUnattendedWindow('latest', windows, 2),
    ).toEqual({ kind: 'scope', windowId: 2 })

    // With no connected panel, the latest minimized window wins.
    const minimizedOnly = [win(1, { isMinimized: true }), win(2, { isMinimized: true })]
    expect(
      policy.resolveUnattendedWindow('latest', minimizedOnly, undefined),
    ).toEqual({ kind: 'scope', windowId: 2 })
  })

  it('latest survives a stale latestWindowId', () => {
    const windows = [win(1, { isPanel: true }), win(2, { isMinimized: true })]
    // 9 is not a plugin window id: fall back to the last plugin window listed.
    expect(policy.resolveUnattendedWindow('latest', windows, 9)).toEqual({
      kind: 'scope',
      windowId: 2,
    })
  })

  it('ask uses a single plugin window directly and asks only on a real choice', () => {
    const single = [win(1), win(2, { isPanel: true })]
    expect(policy.resolveUnattendedWindow('ask', single, 2)).toEqual({
      kind: 'scope',
      windowId: 2,
    })

    const both = [win(1, { isMinimized: true }), win(2, { isPanel: true })]
    expect(policy.resolveUnattendedWindow('ask', both, 2)).toEqual({ kind: 'ask' })
  })

  it('fixed locks the configured window while it is a plugin window', () => {
    const windows = [win(1, { isPanel: true }), win(2, { isMinimized: true })]
    expect(policy.resolveUnattendedWindow('fixed', windows, 1, 2)).toEqual({
      kind: 'scope',
      windowId: 2,
    })
  })

  it('fixed falls back to latest when the fixed window is gone or plugin-closed', () => {
    const windows = [win(1, { isPanel: true }), win(2, { isMinimized: true })]
    // Window 3 does not exist / is not a plugin window.
    expect(policy.resolveUnattendedWindow('fixed', windows, 1, 3)).toEqual({
      kind: 'scope',
      windowId: 1,
    })
    // A fixed id without the plugin open there is equally unusable.
    const closed = [win(1, { isPanel: true }), win(2)]
    expect(policy.resolveUnattendedWindow('fixed', closed, 1, 2)).toEqual({
      kind: 'scope',
      windowId: 1,
    })
  })

  it('fixed without a configured id behaves like latest', () => {
    const windows = [win(1, { isMinimized: true }), win(2, { isPanel: true })]
    expect(policy.resolveUnattendedWindow('fixed', windows, 2, undefined)).toEqual({
      kind: 'scope',
      windowId: 2,
    })
  })
})

describe('pick channel routing', () => {
  let policy: typeof import('../src/background/window-policy')

  beforeEach(async () => {
    vi.resetModules()
    policy = await import('../src/background/window-policy')
  })

  afterEach(() => {
    policy._resetWindowPolicyForTests()
  })

  it('routes a panel answer to the pending request', async () => {
    let delivered: unknown = null
    policy.setWindowPickRequester(async (request) => {
      delivered = request
    })

    // Drive requestPick through the async orchestrator with a mocked chrome:
    // settings in storage.local, two plugin windows, one connected panel.
    const store: Record<string, unknown> = {
      settings: { unattendedWindowPolicy: 'ask' },
    }
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys: unknown) => {
            const list = Array.isArray(keys)
              ? keys
              : typeof keys === 'string'
                ? [keys]
                : Object.keys((keys ?? {}) as Record<string, unknown>)
            const out: Record<string, unknown> = {}
            for (const key of list) if (key in store) out[key] = store[key]
            return out
          }),
        },
      },
      windows: {
        get: vi.fn(async (id: number) => ({ id, type: 'normal' })),
        getAll: vi.fn(async () => [
          {
            id: 1,
            type: 'normal',
            tabs: [{ active: true, title: 'Panel tab', url: 'https://a.example/' }],
          },
          {
            id: 2,
            type: 'normal',
            tabs: [{ active: true, title: 'Min tab', url: 'https://b.example/' }],
          },
        ]),
      },
    }
    const scope = await import('../src/background/automation-scope')
    const minimize = await import('../src/background/panel-minimize')
    const port = { name: 'x' } as unknown as chrome.runtime.Port
    scope.registerPanelWindow(1, port)
    minimize.minimizeWindow(2)

    const pending = policy.resolveUnattendedScope()
    // The ask path runs after settings + window enumeration (several awaits):
    // poll until the request is broadcast instead of guessing tick counts.
    await vi.waitFor(() => {
      expect(delivered).toMatchObject({ type: 'window.pick.request' })
    })

    policy.handleWindowPickResponse((delivered as { requestId: string }).requestId, 2)
    const resolved = await pending
    // The user's explicit pick (window 2, a minimized plugin window) wins.
    expect(resolved).toEqual({ windowId: 2 })

    delete (globalThis as Partial<{ chrome: unknown }>).chrome
  })
})
