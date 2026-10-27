// @vitest-environment jsdom
/**
 * Default placement of the two page buttons: both park in the bottom-right
 * corner, with the picker crosshair directly above the plugin icon, and a
 * user-dragged position still overrides that corner anchoring.
 *
 * jsdom has no layout engine, so the icon's box is handed to the launcher
 * explicitly; everything else (inline styles, observers, resize) is the real
 * content-script code.
 *
 * @module tests/inpage-button-placement
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

function deliver(message: unknown): void {
  for (const listener of listeners) listener(message, {}, () => {})
}

const floatingHost = (): HTMLElement | null =>
  document.getElementById('browser-copilot-floating-host')
const launcherHost = (): HTMLElement | null => document.getElementById('bc-element-picker-launcher')

/** MutationObserver callbacks in jsdom land on the microtask queue. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('default button placement', () => {
  it('parks the crosshair in the bottom-right corner while the panel is open', () => {
    deliver({ type: 'elementPicker.set', enabled: true, locale: 'en', format: 'html' })

    const host = launcherHost()
    expect(host?.style.right).toBe('16px')
    expect(host?.style.top).toBe(`${window.innerHeight - 16 - 40}px`)
  })

  it('parks the plugin icon in the bottom-right corner', () => {
    deliver({ type: 'floating.show' })

    const host = floatingHost()
    expect(host?.style.right).toBe('16px')
    expect(host?.style.bottom).toBe('16px')
    expect(host?.style.top).toBe('')
  })

  it('stacks the crosshair directly above the plugin icon', async () => {
    const iconTop = window.innerHeight - 16 - 40
    const iconBottom = window.innerHeight - 16
    const icon = floatingHost()
    if (!icon) throw new Error('floating button did not mount')
    icon.getBoundingClientRect = () =>
      ({
        x: window.innerWidth - 56,
        y: iconTop,
        left: window.innerWidth - 56,
        top: iconTop,
        right: window.innerWidth - 16,
        bottom: iconBottom,
        width: 40,
        height: 40,
        toJSON: () => ({}),
      }) as DOMRect

    window.dispatchEvent(new Event('resize'))
    await settle()

    const crosshairTop = Number.parseFloat(launcherHost()?.style.top ?? 'NaN')
    expect(crosshairTop).toBe(iconTop - 8 - 40)
    expect(crosshairTop + 40).toBeLessThanOrEqual(iconTop)
  })

  it('keeps a user-dragged position instead of the corner default', () => {
    deliver({ type: 'floating.hide' })
    deliver({ type: 'floating.show', pos: { x: 50, y: 50 } })

    const host = floatingHost()
    expect(host?.style.bottom).toBe('auto')
    expect(host?.style.right).toBe('auto')
    expect(host?.style.left).not.toBe('')
    expect(host?.style.top).not.toBe('')
  })
})
