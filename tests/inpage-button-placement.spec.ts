// @vitest-environment jsdom
/**
 * The two page buttons form ONE floating window: with the plugin minimized,
 * the picker crosshair docks into the icon's host (above the icon by default),
 * and the whole window follows a dragged position. The crosshair only lives on
 * its own, in the bottom-right corner, while the panel is open.
 *
 * jsdom has no layout engine, so the window's height is handed to the code
 * explicitly where the icon-anchored math depends on it.
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
const sent: unknown[] = []

beforeAll(async () => {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message)
        return Promise.resolve(undefined)
      },
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

/** jsdom reports 0 for every box; the docked window is crosshair + 8 + icon. */
function stubWindowHeight(host: HTMLElement): void {
  Object.defineProperty(host, 'offsetHeight', { value: 88, configurable: true })
}

describe('one floating window', () => {
  it('parks the crosshair in the bottom-right corner while the panel is open', () => {
    deliver({ type: 'elementPicker.set', enabled: true, locale: 'en', format: 'html' })

    const host = launcherHost()
    expect(host?.parentElement).toBe(document.documentElement)
    expect(host?.style.right).toBe('16px')
    expect(host?.style.bottom).toBe('16px')
  })

  it('docks the crosshair into the plugin window when the panel is minimized', async () => {
    deliver({ type: 'floating.show' })
    await settle()

    const windowHost = floatingHost()
    const launcher = launcherHost()
    expect(launcher?.parentElement).toBe(windowHost)
    expect(launcher?.style.position).toBe('static')
    expect(windowHost?.style.right).toBe('16px')
    expect(windowHost?.style.bottom).toBe('16px')
  })

  it('keeps the crosshair above the icon in the window stack', () => {
    const windowHost = floatingHost()
    const stack = windowHost?.shadowRoot?.querySelector('.stack')

    expect(stack?.firstElementChild?.tagName).toBe('SLOT')
    expect(stack?.lastElementChild?.tagName).toBe('BUTTON')
    expect(windowHost?.classList.contains('flipped')).toBe(false)
  })

  it('anchors a dragged window by the icon center, crosshair above it', () => {
    const windowHost = floatingHost()
    if (!windowHost) throw new Error('floating window did not mount')
    stubWindowHeight(windowHost)

    deliver({ type: 'floating.show', pos: { x: 50, y: 50 } })

    const iconLeft = window.innerWidth / 2 - 20
    const iconTop = window.innerHeight / 2 - 20
    expect(windowHost.style.left).toBe(`${iconLeft}px`)
    expect(windowHost.style.top).toBe(`${iconTop - 48}px`)
    expect(windowHost.style.right).toBe('auto')
    expect(windowHost.style.bottom).toBe('auto')
    expect(windowHost.classList.contains('flipped')).toBe(false)
  })

  it('flips the stack only when the icon touches the top edge', () => {
    const windowHost = floatingHost()
    if (!windowHost) throw new Error('floating window did not mount')
    stubWindowHeight(windowHost)

    deliver({ type: 'floating.show', pos: { x: 50, y: 0 } })

    expect(windowHost.classList.contains('flipped')).toBe(true)
    expect(windowHost.style.top).toBe('8px')
  })

  it('replaces a window left behind by a dead script and reopens on click', () => {
    const stale = document.createElement('div')
    stale.id = 'browser-copilot-floating-host'
    stale.dataset.stale = '1'
    stale.attachShadow({ mode: 'open' }).innerHTML = '<button type="button"></button>'
    document.documentElement.appendChild(stale)

    deliver({ type: 'floating.hide' })
    deliver({ type: 'floating.show' })

    const windowHost = floatingHost()
    expect(windowHost).not.toBe(stale)
    expect(windowHost?.dataset.stale).toBeUndefined()
    expect(stale.isConnected).toBe(false)

    const button = windowHost?.shadowRoot?.querySelector('button')
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent).toContainEqual({ type: 'floating.expand' })
  })

  it('replaces a crosshair left behind by a dead script', () => {
    const stale = document.createElement('div')
    stale.id = 'bc-element-picker-launcher'
    stale.dataset.stale = '1'
    document.documentElement.appendChild(stale)

    deliver({ type: 'elementPicker.set', enabled: true, locale: 'en', format: 'html' })

    const launcher = launcherHost()
    expect(launcher).not.toBe(stale)
    expect(stale.isConnected).toBe(false)
    expect(launcher?.shadowRoot?.querySelector('button')).not.toBeNull()
  })

  it('returns the crosshair to the corner when the window disappears', async () => {
    deliver({ type: 'floating.hide' })
    await settle()

    expect(floatingHost()).toBeNull()
    const launcher = launcherHost()
    expect(launcher?.parentElement).toBe(document.documentElement)
    expect(launcher?.style.position).toBe('fixed')
    expect(launcher?.style.right).toBe('16px')
    expect(launcher?.style.bottom).toBe('16px')
  })
})
