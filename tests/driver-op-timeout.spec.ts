/**
 * Backstop timeout for injected op round trips (src/background/driver.ts).
 *
 * When a renderer is parked on a native modal (or any non-resolving injected
 * evaluation), chrome.scripting.executeScript settles NEITHER way. Without the
 * timeout a workflow step hangs forever with no error; with it, execOnActiveTab
 * rejects with an OP_INJECTION_TIMEOUT DriverError after 30 s, which the engine
 * routes through its normal onError machinery instead of freezing the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriverError, execOnActiveTab } from '../src/background/driver'
import type { Op, Target } from '../src/lib/ops'

const TAB = { id: 22, windowId: 1, url: 'https://register.example.test/signup' }

const cssTarget = (selector: string): Target => ({
  primary: { how: 'css', value: selector },
  fallbacks: [],
})

let executeScript: ReturnType<typeof vi.fn>
let tabIdSeed = 100

function installChrome(): void {
  executeScript = vi.fn(() => new Promise<unknown[]>(() => {}))
  const on = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    tabs: {
      get: vi.fn(async (id: number) => (id === TAB.id ? TAB : undefined)),
      query: vi.fn(async () => [TAB]),
      onActivated: on(),
      onUpdated: on(),
      onRemoved: on(),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, type: 'normal', focused: true })),
      onRemoved: on(),
      onFocusChanged: on(),
    },
    scripting: { executeScript, insertCSS: vi.fn(), removeCSS: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onDetach: on(),
      onEvent: on(),
    },
  }
}

const hoverOp = (): Op => ({ action: 'hover', target: cssTarget('#register') })

beforeEach(() => {
  installChrome()
  TAB.id = tabIdSeed++
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('execOnActiveTab injection timeout', () => {
  it('rejects with OP_INJECTION_TIMEOUT when the injected call never settles', async () => {
    const pending = execOnActiveTab(hoverOp(), undefined, TAB.id)
    // Attach the handler before advancing timers so the timeout rejection is
    // never observed as unhandled.
    const captured = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await captured
    expect(error).toBeInstanceOf(DriverError)
    expect(error).toMatchObject({ code: 'OP_INJECTION_TIMEOUT' })
  })

  it('does not time out a call that resolves within the budget', async () => {
    executeScript.mockImplementation(async () => [
      { result: { ok: true, found: true, isTopFrame: true } },
    ])
    const result = await execOnActiveTab(hoverOp(), undefined, TAB.id)
    expect(result.ok).toBe(true)
  })

  it('keeps user-cancel (AbortError) semantics ahead of the timeout', async () => {
    const controller = new AbortController()
    const pending = execOnActiveTab(hoverOp(), controller.signal, TAB.id)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('execOnActiveTab actionability pre-check', () => {
  it('does not spend its budget on a missing target that has a kernel wait', async () => {
    // A real run paid 1200ms pre-check + 5000ms kernel wait for one click that
    // never matched. The kernel wait IS the page's chance to render the target;
    // the pre-check must not stack its own budget in front of it.
    executeScript.mockImplementation(async (details: unknown) => {
      const op = (details as { args?: { action?: string }[] }).args?.[0]
      if (op?.action === 'actionability') {
        return [
          { result: { ok: true, found: false, isTopFrame: true, data: { state: 'missing' } } },
        ]
      }
      return [{ result: { ok: true, found: true, isTopFrame: true } }]
    })
    const pending = execOnActiveTab(
      { action: 'click', target: cssTarget('#go'), waitFor: 5000 },
      undefined,
      TAB.id,
    )
    // A pre-check that still waited would be asleep at this point.
    await vi.advanceTimersByTimeAsync(0)
    const result = await pending
    expect(result.ok).toBe(true)
    const probes = executeScript.mock.calls.filter(
      (call) => (call[0] as { args?: { action?: string }[] }).args?.[0]?.action === 'actionability',
    )
    expect(probes).toHaveLength(1)
  })
})
