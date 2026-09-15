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
    expect(policy.resolveUnattendedWindow('latest', windows, 2)).toEqual({
      kind: 'scope',
      windowId: 2,
    })

    // With no connected panel, the latest minimized window wins.
    const minimizedOnly = [win(1, { isMinimized: true }), win(2, { isMinimized: true })]
    expect(policy.resolveUnattendedWindow('latest', minimizedOnly, undefined)).toEqual({
      kind: 'scope',
      windowId: 2,
    })
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

describe('resolveBridgeWindow (pure per-connection policy)', () => {
  let policy: typeof import('../src/background/window-policy')

  beforeEach(async () => {
    vi.resetModules()
    policy = await import('../src/background/window-policy')
  })

  // Windows 1 (panel) and 2 (minimized) currently host the plugin.
  const windows = [win(1, { isPanel: true }), win(2, { isMinimized: true })]
  const id = { agentId: 'id-a', agentName: 'claude@proj' }

  it('defaults with no identity and no bindings (zero-setup behaviour)', () => {
    expect(
      policy.resolveBridgeWindow({ bindings: {}, sessionBindings: new Map(), windows }),
    ).toEqual({ kind: 'default' })
  })

  it('refuses an identity-less request once bindings exist', () => {
    expect(
      policy.resolveBridgeWindow({
        bindings: { 'codex@other': 1 },
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'unbound' })
  })

  it('uses the session id binding first', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: id,
        bindings: { 'claude@proj': 1 },
        sessionBindings: new Map([['id-a', 2]]),
        windows,
      }),
    ).toEqual({ kind: 'window', windowId: 2, source: 'session-id' })
  })

  it('falls through a stale session binding to the name binding', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: id,
        bindings: { 'claude@proj': 2 },
        sessionBindings: new Map([['id-a', 9]]), // window 9 gone
        windows,
      }),
    ).toEqual({ kind: 'window', windowId: 2, source: 'name' })
  })

  it('honours the deprecated legacy pair only when its id matches', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: id,
        bindings: {},
        sessionBindings: new Map(),
        legacy: { activeAgentId: 'id-a', windowId: 2 },
        windows,
      }),
    ).toEqual({ kind: 'window', windowId: 2, source: 'legacy' })

    // A different agent's legacy selection neither serves nor binds it:
    // no bindings exist anywhere, so the result is `default` (the old
    // exclusive gate in agent-api.ts still handles the refusal).
    expect(
      policy.resolveBridgeWindow({
        identity: id,
        bindings: {},
        sessionBindings: new Map(),
        legacy: { activeAgentId: 'id-b', windowId: 2 },
        windows,
      }),
    ).toEqual({ kind: 'default' })
  })

  it('defaults instead of swallowing an agent whose binding windows are all stale', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: id,
        bindings: { 'claude@proj': 9 },
        sessionBindings: new Map([['id-a', 8]]),
        legacy: { activeAgentId: 'id-a', windowId: 7 },
        windows,
      }),
    ).toEqual({ kind: 'default' })
  })

  it('refuses a known-but-unassigned connection once other assignments exist', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: { agentId: 'new', agentName: 'new@proj' },
        bindings: { 'claude@proj': 1 },
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'unbound' })
  })

  it('defaults an unassigned connection while no bindings exist', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: { agentId: 'new', agentName: 'new@proj' },
        bindings: {},
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'default' })
  })

  it('supports a name-only identity (older adapters without agentId)', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: { agentName: 'claude@proj' },
        bindings: { 'claude@proj': 2 },
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'window', windowId: 2, source: 'name' })

    expect(
      policy.resolveBridgeWindow({
        identity: { agentName: 'new@proj' },
        bindings: { 'claude@proj': 2 },
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'unbound' })
  })

  it('shares one window between duplicate names (documented collision)', () => {
    expect(
      policy.resolveBridgeWindow({
        identity: { agentId: 'second-id', agentName: 'claude@proj' },
        bindings: { 'claude@proj': 1 },
        sessionBindings: new Map(),
        windows,
      }),
    ).toEqual({ kind: 'window', windowId: 1, source: 'name' })
  })
})

describe('resolveBridgeTarget (local-agent per-connection windows)', () => {
  let policy: typeof import('../src/background/window-policy')

  /**
   * Chrome stub: `settings` is the stored settings object, `windows` maps id →
   * chrome window (or undefined for a closed id). Callers register plugin
   * windows through automation-scope / panel-minimize, exactly like production.
   */
  function stubChrome(settings: Record<string, unknown>, windows: Record<number, unknown>): void {
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
            for (const key of list) {
              if (key === 'settings') out[key] = settings
            }
            return out
          }),
        },
      },
      windows: {
        get: vi.fn(async (id: number) => windows[id]),
      },
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    policy = await import('../src/background/window-policy')
  })

  afterEach(() => {
    policy._resetWindowPolicyForTests()
    delete (globalThis as Partial<{ chrome: unknown }>).chrome
  })

  it('scopes a connection to its assigned panel window', async () => {
    stubChrome(
      { localAgentBindings: { 'claude@proj': 7 } },
      { 7: { id: 7, type: 'normal' } },
    )
    const scope = await import('../src/background/automation-scope')
    const port = { name: 'x' } as unknown as chrome.runtime.Port
    scope.registerPanelWindow(7, port)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 7 }, unbound: false })
  })

  it('accepts an assigned minimized (plugin) window too', async () => {
    stubChrome(
      { localAgentBindings: { 'claude@proj': 2 } },
      { 2: { id: 2, type: 'normal' } },
    )
    const minimize = await import('../src/background/panel-minimize')
    minimize.minimizeWindow(2)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 2 }, unbound: false })
  })

  it('survives a worker restart: the name binding resolves with an empty session map', async () => {
    // A fresh module (resetModules) has no agentId memory; the persisted name
    // binding alone must be enough.
    stubChrome(
      { localAgentBindings: { 'claude@proj': 7 } },
      { 7: { id: 7, type: 'normal' } },
    )
    const scope = await import('../src/background/automation-scope')
    scope.registerPanelWindow(7, { name: 'x' } as unknown as chrome.runtime.Port)

    const result = await policy.resolveBridgeTarget({
      agentId: 'brand-new-process-id',
      agentName: 'claude@proj',
    })
    expect(result).toEqual({ scope: { windowId: 7 }, unbound: false })
  })

  it('prefers an in-session id assignment over the persisted name binding', async () => {
    stubChrome(
      { localAgentBindings: { 'claude@proj': 1 } },
      {
        1: { id: 1, type: 'normal' },
        2: { id: 2, type: 'normal' },
      },
    )
    const scope = await import('../src/background/automation-scope')
    scope.registerPanelWindow(1, { name: 'a' } as unknown as chrome.runtime.Port)
    scope.registerPanelWindow(2, { name: 'b' } as unknown as chrome.runtime.Port)
    // The panel assigned this id to window 2 during this worker's life.
    policy.rememberAgentWindow('id-a', 2)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 2 }, unbound: false })
  })

  it('reports unbound for an unassigned connection once bindings exist', async () => {
    // No plugin window required: unbound returns before default resolution.
    stubChrome({ localAgentBindings: { 'codex@other': 5 } }, {})

    await expect(
      policy.resolveBridgeTarget({ agentId: 'new', agentName: 'new@proj' }),
    ).resolves.toEqual({ scope: undefined, unbound: true })

    // Identity-less warmup (a plain ping) is unbound too.
    await expect(policy.resolveBridgeTarget()).resolves.toEqual({
      scope: undefined,
      unbound: true,
    })
  })

  it('falls back to the latest plugin window when the binding is stale', async () => {
    // Bound to window 3, but it hosts no plugin anymore; panel window 1 is the
    // default resolution target.
    stubChrome(
      { localAgentBindings: { 'claude@proj': 3 } },
      { 1: { id: 1, type: 'normal' }, 3: { id: 3, type: 'normal' } },
    )
    const scope = await import('../src/background/automation-scope')
    scope.registerPanelWindow(1, { name: 'x' } as unknown as chrome.runtime.Port)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 1 }, unbound: false })
  })

  it('with zero bindings it behaves like the default unattended resolution', async () => {
    stubChrome({}, { 1: { id: 1, type: 'normal' } })
    const scope = await import('../src/background/automation-scope')
    scope.registerPanelWindow(1, { name: 'x' } as unknown as chrome.runtime.Port)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 1 }, unbound: false })
  })

  it('still honours the deprecated legacy selection for its matching id', async () => {
    stubChrome(
      { localAgentActiveAgent: 'id-a', localAgentWindowId: 7 },
      { 7: { id: 7, type: 'normal' } },
    )
    const scope = await import('../src/background/automation-scope')
    scope.registerPanelWindow(7, { name: 'x' } as unknown as chrome.runtime.Port)

    await expect(
      policy.resolveBridgeTarget({ agentId: 'id-a', agentName: 'claude@proj' }),
    ).resolves.toEqual({ scope: { windowId: 7 }, unbound: false })
  })
})
