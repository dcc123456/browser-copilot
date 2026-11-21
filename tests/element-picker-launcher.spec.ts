/**
 * The element-picker crosshair as an independent floating control.
 *
 * Three behaviours are load-bearing here and none of them was true before:
 * a press never moves the page's focus (blur-closed dropdowns must survive),
 * the button drags on its own even when the minimized icon is absent, and it
 * never renders inside that icon's window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

const HOST_ID = 'bc-element-picker-launcher'
const FLOATING_HOST_ID = 'browser-copilot-floating-host'

let dom: JSDOM
let sendMessage: ReturnType<typeof vi.fn>

function bootDom(): void {
  dom = new JSDOM('<!doctype html><html><body><input id="q" /></body></html>', {
    url: 'https://example.test/',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.MutationObserver = dom.window.MutationObserver
  g.Element = dom.window.Element
  g.HTMLElement = dom.window.HTMLElement
  g.Node = dom.window.Node
  g.CustomEvent = dom.window.CustomEvent
}

function pointer(
  type: string,
  init: { clientX: number; clientY: number; pointerId?: number },
): Event {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.assign(event, {
    pointerId: init.pointerId ?? 1,
    isPrimary: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  })
  return event
}

function crosshairButton(): HTMLButtonElement {
  const host = document.getElementById(HOST_ID)
  if (!host?.shadowRoot) throw new Error('crosshair host missing')
  const button = host.shadowRoot.querySelector('button')
  if (!button) throw new Error('crosshair button missing')
  return button
}

beforeEach(async () => {
  bootDom()
  vi.resetModules()
  sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === 'elementPicker.status'
      ? {
          enabled: true,
          locale: 'en',
          format: 'html',
          selectOnly: false,
          position: { x: 92, y: 88 },
        }
      : { ok: true },
  )
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
  }
  await import('../src/inpage/element-picker-launcher')
  await vi.waitFor(() => expect(document.getElementById(HOST_ID)).toBeTruthy())
})

describe('element-picker launcher', () => {
  it('mounts as a fixed control on the document, not inside the floating icon', async () => {
    const floating = document.createElement('div')
    floating.id = FLOATING_HOST_ID
    document.documentElement.appendChild(floating)
    await vi.waitFor(() =>
      expect(document.getElementById(HOST_ID)?.parentElement).toBe(document.documentElement),
    )
    expect(floating.contains(document.getElementById(HOST_ID))).toBe(false)
  })

  it('is not reachable with Tab and keeps the page focus on press', async () => {
    const input = document.getElementById('q') as HTMLInputElement
    input.focus()
    let blurs = 0
    input.addEventListener('blur', () => {
      blurs += 1
    })
    const button = crosshairButton()
    expect(button.tabIndex).toBe(-1)

    // AC-2: a popover that closes on the press itself must not see it either.
    let pagePresses = 0
    window.addEventListener('pointerdown', () => {
      pagePresses += 1
    })
    button.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }))
    // A picker already open would short-circuit the click; keep this press a
    // click by dispatching up, and block the picker with a probe marker.
    const marker = document.createElement('div')
    marker.id = 'element-picker'
    document.body.appendChild(marker)
    button.dispatchEvent(pointer('pointerup', { clientX: 100, clientY: 100 }))

    expect(blurs).toBe(0)
    expect(pagePresses).toBe(0)
    expect(document.activeElement).toBe(input)
  })

  it('drags independently and persists its own position', async () => {
    const button = crosshairButton()
    button.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }))
    button.dispatchEvent(pointer('pointermove', { clientX: 220, clientY: 180 }))
    button.dispatchEvent(pointer('pointerup', { clientX: 220, clientY: 180 }))

    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.some((call) => call[0]?.type === 'elementPicker.move')).toBe(
        true,
      )
    })
    const host = document.getElementById(HOST_ID) as HTMLElement
    expect(host.style.left).not.toBe('')
    expect(host.style.position).toBe('fixed')
  })
})
