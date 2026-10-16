/**
 * Native-dialog auto-dismiss in the passive CDP monitor
 * (src/background/cdp-monitor.ts).
 *
 * A native alert/confirm/prompt parks the renderer JS thread, and an
 * unattended run that triggered it (e.g. a register button whose click handler
 * calls alert()) used to hang forever on the pending chrome.scripting call,
 * because nothing owned the dialog. The monitor now enables the Page domain and
 * answers every Page.javascriptDialogOpening event: accept prompt/confirm/alert,
 * dismiss beforeunload — mirroring the runner's Playwright policy.
 *
 * Like tests/cdp-console-log.spec.ts, chrome.debugger is stubbed before a fresh
 * dynamic import so the module-level listener registration sees the stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type CdpListener = (source: unknown, method: string, params?: Record<string, unknown>) => void

interface SentCommand {
  method: string
  params?: Record<string, unknown>
}

async function loadFreshMonitor(): Promise<{
  mod: typeof import('../src/background/cdp-monitor')
  listeners: CdpListener[]
  sent: SentCommand[]
}> {
  const listeners: CdpListener[] = []
  const sent: SentCommand[] = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      onEvent: { addListener: (fn: CdpListener) => listeners.push(fn) },
      onDetach: { addListener: () => undefined },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params })
        return undefined
      },
    },
  }
  vi.resetModules()
  const mod = await import('../src/background/cdp-monitor')
  return { mod, listeners, sent }
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('native dialog auto-dismiss', () => {
  it('enables the Page domain when attaching', async () => {
    const { mod, sent } = await loadFreshMonitor()
    await mod.ensureTabMonitor(1)
    expect(sent.map((c) => c.method)).toContain('Page.enable')
  })

  it('accepts alert/confirm dialogs', async () => {
    const { mod, listeners, sent } = await loadFreshMonitor()
    await mod.ensureTabMonitor(1)
    for (const type of ['alert', 'confirm']) {
      sent.length = 0
      listeners[0]!({ tabId: 1 }, 'Page.javascriptDialogOpening', {
        type,
        message: 'Registration succeeded',
      })
      await Promise.resolve()
      expect(sent).toContainEqual({
        method: 'Page.handleJavaScriptDialog',
        params: { accept: true },
      })
    }
  })

  it('accepts prompt() and echoes back its default prompt text', async () => {
    const { mod, listeners, sent } = await loadFreshMonitor()
    await mod.ensureTabMonitor(1)
    listeners[0]!({ tabId: 1 }, 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Captcha?',
      defaultPrompt: '',
    })
    await Promise.resolve()
    expect(sent).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true, promptText: '' },
    })
  })

  it('dismisses beforeunload prompts instead of accepting navigation away', async () => {
    const { mod, listeners, sent } = await loadFreshMonitor()
    await mod.ensureTabMonitor(1)
    listeners[0]!({ tabId: 1 }, 'Page.javascriptDialogOpening', {
      type: 'beforeunload',
      message: 'Leave site?',
    })
    await Promise.resolve()
    expect(sent).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    })
  })

  it('ignores dialog events from tabs it does not monitor', async () => {
    const { listeners, sent } = await loadFreshMonitor()
    listeners[0]!({ tabId: 99 }, 'Page.javascriptDialogOpening', { type: 'alert' })
    await Promise.resolve()
    expect(sent.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false)
  })
})
