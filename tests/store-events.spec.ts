// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyStoreChanged, onStoreChanged, STORE_CHANGED } from '../src/lib/store-events'

/**
 * Minimal `chrome.runtime` double that records the registered listeners so a
 * runtime message can be delivered the way Chrome would deliver it.
 */
function makeChromeStub(): {
  listeners: Array<(message: unknown) => void>
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>
    onMessage: {
      addListener: (fn: (message: unknown) => void) => void
      removeListener: (fn: (message: unknown) => void) => void
    }
  }
} {
  const listeners: Array<(message: unknown) => void> = []
  return {
    listeners,
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        },
      },
    },
  }
}

describe('store change bus', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('delivers a same-frame change to a listener', () => {
    // The panel's tabs share one frame, and a runtime message deliberately skips
    // the sender's own frame — so this channel is the only way a save made in
    // ChatTab reaches the Workflows tab.
    const handler = vi.fn()
    const off = onStoreChanged('workflows', handler)

    notifyStoreChanged('workflows')

    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it('ignores a change to a different key', () => {
    const handler = vi.fn()
    const off = onStoreChanged('workflows', handler)

    notifyStoreChanged('settings')

    expect(handler).not.toHaveBeenCalled()
    off()
  })

  it('stops delivering once unsubscribed', () => {
    const handler = vi.fn()
    const off = onStoreChanged('workflows', handler)
    off()

    notifyStoreChanged('workflows')

    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers a change that arrives as a runtime message', () => {
    // How another window's panel or the service worker announces a write.
    const chrome = makeChromeStub()
    vi.stubGlobal('chrome', chrome)
    const handler = vi.fn()
    const off = onStoreChanged('settings', handler)

    for (const listener of chrome.listeners) listener({ type: STORE_CHANGED, key: 'settings' })

    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it('ignores unrelated runtime messages', () => {
    const chrome = makeChromeStub()
    vi.stubGlobal('chrome', chrome)
    const handler = vi.fn()
    const off = onStoreChanged('settings', handler)

    for (const listener of chrome.listeners) {
      listener({ type: 'skills.changed' })
      listener({ type: STORE_CHANGED, key: 'workflows' })
      listener(null)
    }

    expect(handler).not.toHaveBeenCalled()
    off()
  })

  it('pushes a runtime message so other contexts hear the change', () => {
    const chrome = makeChromeStub()
    vi.stubGlobal('chrome', chrome)

    notifyStoreChanged('workflows')

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: STORE_CHANGED,
      key: 'workflows',
    })
  })

  it('never throws when there is no runtime to notify', () => {
    // A missed notification only costs a refresh on the next poll; it must never
    // take a write down with it.
    vi.stubGlobal('chrome', undefined)

    expect(() => notifyStoreChanged('workflows')).not.toThrow()
  })

  it('never throws when the runtime rejects the send (no panel open)', () => {
    const chrome = makeChromeStub()
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('no receiving end'))
    vi.stubGlobal('chrome', chrome)

    expect(() => notifyStoreChanged('workflows')).not.toThrow()
  })
})
