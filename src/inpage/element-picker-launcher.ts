/**
 * On-page element-picker launcher.
 *
 * A static content script parked on every http(s) page. It stays inert until
 * the `elementPickerEnabled` setting is on — the worker's boot reply
 * (`elementPicker.status`) and its `elementPicker.set` broadcasts decide.
 * Clicking the crosshair button starts the shared picker in `copy` mode.
 *
 * The button is an INDEPENDENT floating control (spec 2026-11-21): it keeps
 * its own saved position, is draggable with or without the minimized plugin
 * icon on the page, and the two never overlap — whichever one is dragged keeps
 * its drop point and the other yields. It never docks into the plugin window.
 *
 * Pressing it must not cost the page its focus: a dropdown that closes on
 * `blur` (or on the page's own click-outside handler) would disappear before
 * the picker even opens. `pointerdown` is therefore cancelled and the previous
 * `activeElement` is restored after the press; the picker's own overlay already
 * swallows the presses that follow.
 *
 * The button lives in a Shadow DOM so page CSS cannot restyle it, and the host
 * never intercepts page events outside the button itself.
 *
 * @module inpage/element-picker-launcher
 */

import type {
  ElementPickerControl,
  ElementPickerLauncherMessage,
  ElementPickerStatusResponse,
} from '../lib/messages'
import { avoidOverlap, clampBox, type Box } from '../lib/floating-layout'
import { startPicker } from './element-picker'

const HOST_ID = 'bc-element-picker-launcher'
const FLOATING_HOST_ID = 'browser-copilot-floating-host'
const PICKER_ID = 'element-picker'
const EDGE = 16
const BUTTON_SIZE = 40
/** Pointer travel below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 6
const BUTTON_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>'

type PickerLocale = 'en' | 'zh'
type CopyFormat = ElementPickerControl['format']

let locale: PickerLocale = 'en'
let copyFormat: CopyFormat = 'html'
let selectOnly = false
let enabled = false

// --- instance ownership -------------------------------------------------------
// A reinjected copy takes over the DOM its dead predecessor left behind: that
// host still renders a crosshair, but its `chrome.runtime` is invalidated.
const INSTANCE: object = {}
const ownerScope = globalThis as { __bcPickerLauncherInstance?: object }
ownerScope.__bcPickerLauncherInstance = INSTANCE
const isActiveInstance = (): boolean => ownerScope.__bcPickerLauncherInstance === INSTANCE

let ownedHost: HTMLElement | null = null
let ownedButton: HTMLButtonElement | null = null
/** Focus to restore once the picker overlay has mounted (it mounts asynchronously). */
let focusBeforePress: Element | null = null
let pressPointerId: number | null = null
let dragPointerId: number | null = null
let dragStart = { x: 0, y: 0 }
let dragOrigin: Box | null = null
let dragged = false
/** The crosshair's own position: center in viewport percentages. */
let currentPos: { x: number; y: number } | null = null

function copyFormatOf(value: unknown): CopyFormat {
  return value === 'selector' || value === 'text' ? value : 'html'
}

function label(): string {
  if (selectOnly) return locale === 'zh' ? '选中页面元素（不复制）' : 'Select a page element'
  return locale === 'zh' ? '选择页面元素并复制' : 'Pick a page element and copy it'
}

function applyLabel(): void {
  const button = ownedHost?.shadowRoot?.querySelector('button')
  if (!button) return
  button.title = label()
  button.setAttribute('aria-label', label())
}

// --- position ----------------------------------------------------------------

function iconAt(pos: { x: number; y: number }): Box {
  return clampBox(
    {
      left: (pos.x / 100) * window.innerWidth - BUTTON_SIZE / 2,
      top: (pos.y / 100) * window.innerHeight - BUTTON_SIZE / 2,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
    },
    { width: window.innerWidth, height: window.innerHeight },
  )
}

function positionOf(box: Box): { x: number; y: number } {
  return {
    x: ((box.left + BUTTON_SIZE / 2) / Math.max(1, window.innerWidth)) * 100,
    y: ((box.top + BUTTON_SIZE / 2) / Math.max(1, window.innerHeight)) * 100,
  }
}

/** Default parking spot: bottom-right, above where the minimized icon sits. */
function defaultPosition(): { x: number; y: number } {
  return {
    x: ((window.innerWidth - EDGE - BUTTON_SIZE / 2) / Math.max(1, window.innerWidth)) * 100,
    y: ((window.innerHeight - EDGE - BUTTON_SIZE / 2) / Math.max(1, window.innerHeight)) * 100,
  }
}

function placeHost(host: HTMLElement, box: Box): void {
  host.style.left = `${box.left}px`
  host.style.top = `${box.top}px`
  host.style.right = 'auto'
  host.style.bottom = 'auto'
}

/** The plugin icon's box, when the minimized window is on this page. */
function floatingBox(): Box | undefined {
  const host = document.getElementById(FLOATING_HOST_ID)
  if (!host) return undefined
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/**
 * Applies the saved position and clears the floating icon. Only the crosshair
 * moves here: the icon keeps its own saved spot (whichever was dragged yields).
 */
function applyPosition(): void {
  const host = ownedHost
  if (!host?.isConnected) return
  let box = iconAt(currentPos ?? defaultPosition())
  const other = floatingBox()
  if (other)
    box = avoidOverlap(box, other, { width: window.innerWidth, height: window.innerHeight })
  placeHost(host, box)
  currentPos = positionOf(box)
}

// --- DOM ---------------------------------------------------------------------

function createHost(): HTMLElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.all = 'initial'
  host.style.position = 'fixed'
  host.style.zIndex = '2147483647'
  host.style.pointerEvents = 'none'

  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      button {
        pointer-events: auto;
        width: ${BUTTON_SIZE}px;
        height: ${BUTTON_SIZE}px;
        border-radius: 50%;
        border: 1px solid rgba(15, 23, 42, 0.15);
        padding: 0;
        cursor: crosshair;
        background: #ffffff;
        color: #334155;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
        touch-action: none;
      }
      button:hover {
        transform: scale(1.08);
        color: #4f46e5;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.35);
      }
      button:active { transform: scale(0.96); }
    </style>
    <button type="button" tabindex="-1">${BUTTON_ICON}</button>
  `

  const button = shadow.querySelector('button')
  if (!button) return host
  // Never take focus from the page: Tab must not land here, and a press must
  // not move `activeElement` (the page's blur/focusout listeners are what close
  // dropdowns). `preventDefault` keeps the click, it only suppresses the focus.
  button.tabIndex = -1

  button.addEventListener('pointermove', (event) => {
    if (dragPointerId !== event.pointerId || !dragOrigin) return
    const dx = event.clientX - dragStart.x
    const dy = event.clientY - dragStart.y
    if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    dragged = true
    const box = clampBox(
      { ...dragOrigin, left: dragOrigin.left + dx, top: dragOrigin.top + dy },
      { width: window.innerWidth, height: window.innerHeight },
    )
    placeHost(host, box)
    currentPos = positionOf(box)
  })

  const endDrag = (event: PointerEvent): void => {
    if (dragPointerId !== event.pointerId) return
    dragPointerId = null
    try {
      button.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    if (!dragged) {
      // A plain click: the page must not learn about this press either, so the
      // window-level guard swallowed it. Open the picker, then put the page's
      // focus back AFTER the overlay exists — the overlay mount is what used to
      // clear it, so restoring before `startPicker` was too early.
      const previous = focusBeforePress
      if (previous) {
        if (document.getElementById(PICKER_ID)) return
        void startPicker({ pickerId: PICKER_ID, mode: 'copy', copyFormat, locale, selectOnly })
        restoreFocusSoon(previous)
      }
      return
    }
    dragged = false
    applyPosition()
    if (currentPos) {
      void chrome.runtime
        .sendMessage({ type: 'elementPicker.move', x: currentPos.x, y: currentPos.y })
        .catch(() => {})
    }
  }
  button.addEventListener('pointerup', endDrag)
  button.addEventListener('pointercancel', endDrag)
  // A drag must not also start the picker (the press itself was swallowed at
  // window capture, so the page never sees a click on this control either).
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  })
  ownedButton = button
  return host
}

/**
 * Removes every crosshair host this live instance does not own: a dead
 * predecessor may have left one (or a nested duplicate) behind.
 */
/**
 * Swallows the press that lands on our control at the FIRST capture station, so
 * a popover that closes on `pointerdown` (or on any page-level listener) never
 * sees it. The same mechanism the open picker uses for its overlay, applied at
 * the launcher. Our own drag state is updated here, before the event dies.
 */
function installPressGuard(): void {
  const guard = (event: PointerEvent | MouseEvent): void => {
    const host = ownedHost
    const button = ownedButton
    if (!host || !button || !event.composedPath().includes(host)) return
    if ('isPrimary' in event && !event.isPrimary) return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type !== 'pointerdown') return
    if (document.activeElement instanceof Element) focusBeforePress = document.activeElement
    pressPointerId = (event as PointerEvent).pointerId
    dragPointerId = pressPointerId
    dragStart = { x: event.clientX, y: event.clientY }
    dragOrigin = iconAt(currentPos ?? defaultPosition())
    dragged = false
    try {
      button.setPointerCapture(pressPointerId)
    } catch {
      /* capture is best-effort */
    }
  }
  window.addEventListener('pointerdown', guard, true)
  // Compatibility mouse events must not leak to the page either.
  window.addEventListener('mousedown', guard, true)
  window.addEventListener(
    'mouseup',
    (event) => {
      if (ownedHost && event.composedPath().includes(ownedHost)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    true,
  )
}

/** Focus the page's control again once the overlay really exists. */
function restoreFocusSoon(previous: Element): void {
  const restore = (): void => {
    if (!previous.isConnected) return
    const focusable = previous as HTMLElement
    if (typeof focusable.focus === 'function') focusable.focus({ preventScroll: true })
  }
  requestAnimationFrame(() => {
    restore()
    setTimeout(restore, 0)
    setTimeout(restore, 60)
  })
}

function dropStaleHosts(): void {
  for (const host of document.querySelectorAll(`#${HOST_ID}`)) {
    if (host !== ownedHost) host.remove()
  }
}

/**
 * Independent mount: always a fixed control on the document, never a child of
 * the floating plugin window (that docking is what made "draggable only while
 * the icon exists" true).
 */
function mount(): void {
  if (!isActiveInstance()) return
  dropStaleHosts()
  if (!ownedHost || !ownedHost.isConnected) ownedHost = createHost()
  if (ownedHost.parentElement !== document.documentElement) {
    document.documentElement.appendChild(ownedHost)
  }
  ownedHost.style.display = 'block'
  applyPosition()
  applyLabel()
}

function unmount(): void {
  if (!isActiveInstance()) return
  dropStaleHosts()
  ownedHost?.remove()
  ownedHost = null
}

// The plugin window mounts and unmounts as the panel minimizes and expands.
// Re-apply the position so the crosshair steps aside when the icon appears.
new MutationObserver(() => {
  if (enabled) mount()
}).observe(document.documentElement, { childList: true })

window.addEventListener('resize', () => {
  if (enabled) applyPosition()
})

installPressGuard()

/** Boot: the worker knows the toggle, the payload and the saved position. */
void chrome.runtime
  .sendMessage({ type: 'elementPicker.status' } satisfies ElementPickerLauncherMessage)
  .then((response: unknown) => {
    const status = response as ElementPickerStatusResponse | undefined
    locale = status?.locale === 'zh' ? 'zh' : 'en'
    copyFormat = copyFormatOf(status?.format)
    selectOnly = status?.selectOnly === true
    const position = status?.position
    if (position && typeof position.x === 'number' && typeof position.y === 'number') {
      currentPos = position
    }
    enabled = status?.enabled === true
    if (enabled) mount()
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
    if (!isActiveInstance()) return
    const msg = message as Partial<ElementPickerControl> | undefined
    if (msg?.type !== 'elementPicker.set') return
    locale = msg.locale === 'zh' ? 'zh' : 'en'
    copyFormat = copyFormatOf(msg.format)
    selectOnly = msg.selectOnly === true
    enabled = msg.enabled === true
    if (enabled) mount()
    else unmount()
    sendResponse({ ok: true })
  },
)
