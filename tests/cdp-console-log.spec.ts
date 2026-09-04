/**
 * Console-capture side of the passive CDP monitor (src/background/cdp-monitor.ts).
 *
 * The module registers its chrome.debugger.onEvent listener once at import
 * time (guarded by a chrome global), so each test stubs globalThis.chrome
 * BEFORE dynamically importing a fresh module instance — that yields a clean
 * monitor map plus a captured listener we can feed CDP events through, with
 * no real chrome.debugger involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type CdpListener = (source: unknown, method: string, params?: Record<string, unknown>) => void

interface Stub {
  listeners: CdpListener[]
  commands: string[]
}

/** Installs a fake chrome.debugger on globalThis; optional attach rejection. */
function stubChromeDebugger(attachError?: Error): Stub {
  const listeners: CdpListener[] = []
  const commands: string[] = []
  const debuggerStub = {
    onEvent: { addListener: (fn: CdpListener) => listeners.push(fn) },
    onDetach: { addListener: (_fn: (source: unknown) => void) => undefined },
    attach: async () => {
      if (attachError) throw attachError
      return undefined
    },
    detach: async () => undefined,
    sendCommand: async (_target: unknown, method: string) => {
      commands.push(method)
      return undefined
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = { debugger: debuggerStub }
  return { listeners, commands }
}

/** Fresh module instance per test: resetModules + chrome stub already installed. */
async function loadFreshModule(attachError?: Error) {
  const stub = stubChromeDebugger(attachError)
  vi.resetModules()
  const mod = await import('../src/background/cdp-monitor')
  return { ...stub, mod }
}

function emit(
  listeners: CdpListener[],
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): void {
  for (const listener of listeners) listener({ tabId }, method, params)
}

const consoleCall = (type: string, text: string) => ({
  method: 'Runtime.consoleAPICalled',
  params: { type, args: [{ value: text }] },
})

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('console capture levels', () => {
  it('maps consoleAPICalled: error/assert→error, warning→warning, others→log', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(1)
    for (const [type, text] of [
      ['error', 'boom'],
      ['assert', 'assertion failed'],
      ['warning', 'careful'],
      ['log', 'hello'],
      ['info', 'info text'],
      ['debug', 'debug text'],
      ['table', 'tabular'],
    ] as const) {
      const { method, params } = consoleCall(type, text)
      emit(listeners, 1, method, params)
    }
    const all = mod.getConsoleEntries(1, 'all')
    expect(all.map((e) => e.level)).toEqual([
      'error',
      'error',
      'warning',
      'log',
      'log',
      'log',
      'log',
    ])
    expect(all[0]!.text).toBe('boom')
  })

  it('captures Log.entryAdded at every level', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(2)
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'error', text: 'net::ERR_ABORTED 404' } })
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'warning', text: 'deprecated API' } })
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'info', text: 'loaded' } })
    const all = mod.getConsoleEntries(2, 'all')
    expect(all.map((e) => [e.level, e.text])).toEqual([
      ['error', 'net::ERR_ABORTED 404'],
      ['warning', 'deprecated API'],
      ['log', 'loaded'],
    ])
  })

  it('records uncaught exceptions as errors', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(3)
    emit(listeners, 3, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: 'TypeError: x is not a function' } },
    })
    expect(mod.getConsoleEntries(3).map((e) => e.text)).toEqual([
      'TypeError: x is not a function',
    ])
  })
})

describe('getConsoleEntries', () => {
  it('defaults to errors-only (error + warning, no plain logs)', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(4)
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'noise' }] })
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'w1' }] })
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'e1' }] })
    expect(mod.getConsoleEntries(4).map((e) => e.text)).toEqual(['w1', 'e1'])
    expect(mod.getConsoleEntries(4, 'all').map((e) => e.text)).toEqual(['noise', 'w1', 'e1'])
  })

  it('returns [] for a tab without a monitor', async () => {
    const { mod } = await loadFreshModule()
    expect(mod.getConsoleEntries(99, 'all')).toEqual([])
  })

  it('keeps only the newest 200 entries', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(5)
    for (let i = 0; i < 205; i += 1) {
      emit(listeners, 5, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `m${i}` }] })
    }
    const all = mod.getConsoleEntries(5, 'all')
    expect(all.length).toBe(200)
    expect(all[0]!.text).toBe('m5')
    expect(all[199]!.text).toBe('m204')
  })
})

describe('attach resilience', () => {
  it('tolerates "already attached" and still records', async () => {
    const { mod, listeners } = await loadFreshModule(
      new Error('Another debugger is already attached to this target'),
    )
    await mod.ensureTabMonitor(6)
    emit(listeners, 6, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'e2' }] })
    expect(mod.getConsoleEntries(6).map((e) => e.text)).toEqual(['e2'])
  })

  it('treats other attach failures as no monitor (best-effort)', async () => {
    const { mod, listeners } = await loadFreshModule(new Error('Permission denied'))
    await mod.ensureTabMonitor(7)
    emit(listeners, 7, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x' }] })
    expect(mod.getConsoleEntries(7, 'all')).toEqual([])
  })
})

describe('drainConsoleEntries (action-observation path)', () => {
  it('still yields only fresh errors, consumed once — logs invisible', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(8)
    emit(listeners, 8, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'noise' }] })
    emit(listeners, 8, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'E1' }] })
    expect(mod.drainConsoleEntries(8).map((e) => e.text)).toEqual(['E1'])
    expect(mod.drainConsoleEntries(8)).toEqual([])
  })
})
