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

/** jsdom has no PointerEvent; the drag handlers only read these fields. */
function pointer(target: Element, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  Object.defineProperty(event, 'isPrimary', { value: true })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  target.dispatchEvent(event)
}

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

  it('drags the whole window from the crosshair, not just from the icon', () => {
    deliver({ type: 'floating.show', pos: { x: 50, y: 50 } })
    const windowHost = floatingHost()
    const launcher = launcherHost()
    if (!windowHost || !launcher) throw new Error('window did not mount')
    expect(launcher.parentElement).toBe(windowHost)
    stubWindowHeight(windowHost)

    const leftBefore = windowHost.style.left
    const crosshair = launcher.shadowRoot?.querySelector('button')
    if (!crosshair) throw new Error('crosshair missing')
    let crosshairClicks = 0
    crosshair.addEventListener('click', () => {
      crosshairClicks += 1
    })

    pointer(crosshair, 'pointerdown', 500, 500)
    pointer(windowHost, 'pointermove', 560, 520)
    pointer(windowHost, 'pointerup', 560, 520)

    expect(parseFloat(windowHost.style.left) - parseFloat(leftBefore)).toBe(60)
    expect(sent).toContainEqual({
      type: 'floating.move',
      x: expect.any(Number),
      y: expect.any(Number),
    })

    // The click that follows the drag must not reach the crosshair, or dropping
    // the window would start the picker instead.
    crosshair.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(crosshairClicks).toBe(0)
  })

  it('drops a crosshair left behind by a dead picker script', () => {
    deliver({ type: 'elementPicker.set', enabled: false, locale: 'en', format: 'html' })
    expect(launcherHost()).toBeNull()

    const zombie = document.createElement('div')
    zombie.id = 'bc-element-picker-launcher'
    zombie.dataset.stale = '1'
    document.documentElement.appendChild(zombie)

    deliver({ type: 'floating.hide' })
    deliver({ type: 'floating.show' })

    expect(zombie.isConnected).toBe(false)
    expect(launcherHost()).toBeNull()
  })
})
