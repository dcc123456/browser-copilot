// @vitest-environment jsdom
/**
 * Two INDEPENDENT floating controls (spec 2026-11-21): the minimized plugin
 * icon and the element-picker crosshair.
 *
 * The crosshair used to dock into the icon's window, which is exactly why it
 * could only be dragged while the icon was on the page. Now each control keeps
 * its own position, each drags on its own, and they never overlap. jsdom has no
 * layout engine, so a few boxes are handed to the code explicitly.
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

/** jsdom reports 0 for every box; with no crosshair docked the stack is one icon. */
function stubWindowHeight(host: HTMLElement): void {
  Object.defineProperty(host, 'offsetHeight', { value: 40, configurable: true })
}

describe('independent floating controls', () => {
  it('parks the crosshair on the document while the panel is open', () => {
    deliver({ type: 'elementPicker.set', enabled: true, locale: 'en', format: 'html' })

    const host = launcherHost()
    expect(host?.parentElement).toBe(document.documentElement)
    expect(host?.style.position).toBe('fixed')
    expect(host?.style.left).not.toBe('')
    expect(host?.style.top).not.toBe('')
  })

  it('stays independent when the plugin window mounts (no docking)', async () => {
    deliver({ type: 'floating.show' })
    await settle()

    const windowHost = floatingHost()
    const launcher = launcherHost()
    expect(windowHost).not.toBeNull()
    expect(launcher?.parentElement).toBe(document.documentElement)
    expect(windowHost?.contains(launcher ?? null)).toBe(false)
  })

  it('keeps the icon window anchored by the icon center', () => {
    const windowHost = floatingHost()
    if (!windowHost) throw new Error('floating window did not mount')
    stubWindowHeight(windowHost)

    deliver({ type: 'floating.show', pos: { x: 50, y: 50 } })

    const iconLeft = window.innerWidth / 2 - 20
    const iconTop = window.innerHeight / 2 - 20
    expect(windowHost.style.left).toBe(`${iconLeft}px`)
    expect(windowHost.style.top).toBe(`${iconTop}px`)
    expect(windowHost.style.right).toBe('auto')
    expect(windowHost.style.bottom).toBe('auto')
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

  it('leaves the crosshair where it was when the window disappears', async () => {
    const before = launcherHost()
    const left = before?.style.left
    deliver({ type: 'floating.hide' })
    await settle()

    expect(floatingHost()).toBeNull()
    const launcher = launcherHost()
    expect(launcher?.parentElement).toBe(document.documentElement)
    expect(launcher?.style.left).toBe(left)
  })

  it('drags the crosshair on its own, without moving the icon window', async () => {
    deliver({ type: 'elementPicker.set', enabled: true, locale: 'en', format: 'html' })
    deliver({ type: 'floating.show', pos: { x: 50, y: 50 } })
    await settle()
    const windowHost = floatingHost()
    const launcher = launcherHost()
    if (!windowHost || !launcher) throw new Error('window did not mount')
    const leftBefore = windowHost.style.left

    const crosshair = launcher.shadowRoot?.querySelector('button')
    if (!crosshair) throw new Error('crosshair missing')
    pointer(crosshair, 'pointerdown', 500, 500)
    pointer(crosshair, 'pointermove', 560, 520)
    pointer(crosshair, 'pointerup', 560, 520)
    await settle()

    expect(windowHost.style.left).toBe(leftBefore)
    expect(sent).toContainEqual({
      type: 'elementPicker.move',
      x: expect.any(Number),
      y: expect.any(Number),
    })
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
