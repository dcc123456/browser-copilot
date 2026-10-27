// @vitest-environment jsdom
/**
 * The worker keys its reinjection fallback on a per-script receipt, because
 * every content script of the extension hears every tab message: a resolved
 * `sendMessage` only proves SOME listener exists. Without these receipts a
 * tab holding just the picker launcher looked "delivered" to the floating
 * broadcast, so minimizing the panel showed a crosshair and no restore button.
 *
 * @module tests/content-script-receipts
 */
import { beforeAll, describe, expect, it } from 'vitest'

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => void

const listeners: Listener[] = []

beforeAll(async () => {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: () => Promise.resolve(undefined),
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  }
  await import('../src/inpage/floating-button')
  await import('../src/inpage/element-picker-launcher')
})

/** First listener to answer, exactly how Chrome resolves a tab message. */
function deliver(message: unknown): unknown {
  for (const listener of listeners) {
    let response: unknown
    listener(message, {}, (value?: unknown) => {
      response = value
    })
    if (response !== undefined) return response
  }
  return undefined
}

describe('content script receipts', () => {
  it('the floating button acknowledges its own control messages', () => {
    expect(deliver({ type: 'floating.show' })).toEqual({ ok: true })
    expect(document.getElementById('browser-copilot-floating-host')).not.toBeNull()

    expect(deliver({ type: 'floating.hide' })).toEqual({ ok: true })
    expect(document.getElementById('browser-copilot-floating-host')).toBeNull()
  })

  it('the picker launcher acknowledges its toggle message', () => {
    expect(
      deliver({ type: 'elementPicker.set', enabled: false, locale: 'en', format: 'html' }),
    ).toEqual({ ok: true })
  })
})
