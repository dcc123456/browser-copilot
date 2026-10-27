/**
 * Floating window for the minimized plugin.
 *
 * A static content script parked on every http(s) page. It renders nothing
 * until the service worker says the plugin in THIS window is minimized — then
 * the collapsed side panel is represented by a single floating window holding
 * the plugin icon, which reopens the panel on click. The picker crosshair docks
 * into the same window (see element-picker-launcher): the window is the one
 * fixed box, so the pair moves, flips and repositions together.
 *
 * Lifecycle:
 *  - On load the script asks `floating.status`; a minimized window renders the
 *    window immediately (covers navigation / new tabs while minimized), at the
 *    window's saved drag position when one exists.
 *  - `floating.show` / `floating.hide` (broadcast by the worker) toggle it
 *    live on already-loaded tabs; `floating.show` carries the saved position.
 *    Tabs that predate the extension load have no receiver for the broadcast
 *    — the worker injects this script into them on demand, and the boot-time
 *    `floating.status` query then mounts the window by itself.
 *  - Click sends `floating.expand`; the worker opens the side panel and only
 *    then clears the minimized mark and broadcasts `floating.hide` to every
 *    page of the window (the click gesture is what authorizes the open).
 *  - Dragging the icon moves the whole window; on drop the icon's center is
 *    persisted per window (`floating.move` → worker → chrome.storage) so every
 *    page of this window remounts it where it was dropped.
 *
 * The window lives in a Shadow DOM so page CSS cannot restyle it, with a
 * `<slot>` for the picker crosshair's host (light DOM, so the picker can still
 * find it by id). The overlay never intercepts page events outside the
 * buttons. It is a bundled static content script, so unlike the serialized
 * element picker it MAY import shared modules — keep this file
 * dependency-free anyway, it runs in every frame of every page.
 *
 * @module inpage/floating-button
 */

const HOST_ID = 'browser-copilot-floating-host'
const ICON_PATH = 'icons/icon-48.png'
/** Square button edge in px (must match the shadow style below). */
const BUTTON_SIZE = 40
/** Minimum distance the icon keeps from the viewport edges, in px. */
const VIEWPORT_MARGIN = 8
/** Pointer travel below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4

/** A dropped position: the ICON center in viewport percents (0–100). */
interface ButtonPos {
  x: number
  y: number
}

// --- instance ownership -------------------------------------------------------
// A reinjected copy of this script must take over the DOM its dead predecessor
// left behind: that host still holds a button, but its `chrome.runtime` is
// invalidated, so clicking it does nothing. The isolated world outlives the
// reinjection, so a token stored there tells a live instance from a dead one.
const INSTANCE: object = {}
const ownerScope = globalThis as { __bcFloatingInstance?: object }
ownerScope.__bcFloatingInstance = INSTANCE
const isActiveInstance = (): boolean => ownerScope.__bcFloatingInstance === INSTANCE

function iconUrl(): string {
  try {
    return chrome.runtime.getURL(ICON_PATH)
  } catch {
    return ''
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface IconRect {
  left: number
  top: number
}

/** Keeps the icon fully inside the current viewport. */
function clampIcon(left: number, top: number): IconRect {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN)
  return {
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(top, VIEWPORT_MARGIN, maxTop),
  }
}

/** Percent position (icon center) → icon top-left px. */
function posToIcon(pos: ButtonPos): IconRect {
  return clampIcon(
    (pos.x / 100) * window.innerWidth - BUTTON_SIZE / 2,
    (pos.y / 100) * window.innerHeight - BUTTON_SIZE / 2,
  )
}

/** Inverse: an icon top-left px placement → center percent position. */
function iconToPos(icon: IconRect): ButtonPos {
  return {
    x: ((icon.left + BUTTON_SIZE / 2) / Math.max(1, window.innerWidth)) * 100,
    y: ((icon.top + BUTTON_SIZE / 2) / Math.max(1, window.innerHeight)) * 100,
  }
}

/**
 * Pins the window so the ICON lands on the given top-left: the crosshair docked
 * above it grows upward from there, and flips below only when the icon is too
 * close to the top edge to fit the crosshair above (the `.flipped` rule swaps
 * the stack order).
 */
function placeIcon(host: HTMLElement, icon: IconRect): void {
  const stackOffset = Math.max(0, host.offsetHeight - BUTTON_SIZE)
  const flipped = icon.top < VIEWPORT_MARGIN + stackOffset
  host.classList.toggle('flipped', flipped)
  host.style.left = `${icon.left}px`
  host.style.top = `${flipped ? icon.top : icon.top - stackOffset}px`
  host.style.right = 'auto'
  host.style.bottom = 'auto'
}

/** Applies a persisted icon-center position to a mounted window. */
function applyPos(host: HTMLElement, pos: ButtonPos): void {
  placeIcon(host, posToIcon(pos))
}

let ownedHost: HTMLElement | null = null
let detachCleanup: (() => void) | null = null

function createHost(): HTMLElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  // Reset anything the page inherits onto the host element itself.
  // Default spot: the bottom-right corner, with the crosshair docked above.
  host.style.all = 'initial'
  host.style.position = 'fixed'
  host.style.right = '16px'
  host.style.bottom = '16px'
  host.style.zIndex = '2147483647'
  host.style.pointerEvents = 'none'
  return host
}

/**
 * Removes every window element that this live instance does not own: a dead
 * predecessor may have left one (or a nested duplicate) behind, and adopting
 * it would keep an inert button on the page.
 */
function dropStaleHosts(): void {
  for (const host of document.querySelectorAll(`#${HOST_ID}`)) {
    if (host !== ownedHost) host.remove()
  }
}

function mount(pos?: ButtonPos): void {
  if (!isActiveInstance()) return
  dropStaleHosts()

  if (ownedHost?.isConnected) {
    if (pos) applyPos(ownedHost, pos)
    return
  }

  const host = createHost()
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .stack {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        pointer-events: none;
      }
      /* Near the top edge there is no room above the icon: show the crosshair
         below it instead. */
      :host(.flipped) .stack { flex-direction: column-reverse; }
      button {
        pointer-events: auto;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 1px solid rgba(15, 23, 42, 0.15);
        padding: 0;
        cursor: pointer;
        background: #ffffff;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
        touch-action: none;
      }
      button:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.35);
      }
      button:active { transform: scale(0.96); }
      /* Mid-drag: no hover pulse, grab cursor. */
      button.dragging {
        transform: none;
        transition: none;
        cursor: grabbing;
      }
      img {
        width: 26px;
        height: 26px;
        display: block;
        pointer-events: none;
      }
    </style>
    <div class="stack">
      <slot></slot>
      <button type="button" title="Browser Copilot" aria-label="Browser Copilot">
        <img alt="" draggable="false" />
      </button>
    </div>
  `

  const img = shadow.querySelector('img')
  const src = iconUrl()
  if (img && src) img.src = src
  const button = shadow.querySelector('button')
  if (!button) return

  // Restore the saved position (boot-time status reply or a floating.show
  // broadcast both carry it).
  let currentPos = pos ?? null
  if (currentPos) applyPos(host, currentPos)

  // The docked crosshair changing height (mounting, dismissing) grows the
  // window upward; re-anchor so a positioned icon does not move. jsdom has no
  // layout engine, hence the feature check.
  const sizeWatch =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (currentPos) applyPos(host, currentPos)
        })
      : null
  sizeWatch?.observe(host)

  const onResize = (): void => {
    if (currentPos) applyPos(host, currentPos)
  }
  window.addEventListener('resize', onResize)

  // --- drag to move ----------------------------------------------------------
  // pointerdown → capture on the button; travel beyond the threshold turns the
  // press into a drag (reposition live, clamp inside the viewport); on drop the
  // icon's center is persisted per window. A press that never crossed the
  // threshold stays a click (expand). The click listener below swallows the
  // click event that follows a real drag.
  let dragPointerId: number | null = null
  let dragStart = { x: 0, y: 0 }
  let dragOrigin: IconRect = { left: 0, top: 0 }
  let dragged = false

  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return
    const rect = button.getBoundingClientRect()
    dragOrigin = { left: rect.left, top: rect.top }
    dragStart = { x: event.clientX, y: event.clientY }
    dragged = false
    dragPointerId = event.pointerId
    try {
      button.setPointerCapture(event.pointerId)
    } catch {
      /* capture is best-effort; moves still arrive while the pointer stays */
    }
  })

  button.addEventListener('pointermove', (event) => {
    if (dragPointerId !== event.pointerId) return
    const dx = event.clientX - dragStart.x
    const dy = event.clientY - dragStart.y
    if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!dragged) {
      dragged = true
      button.classList.add('dragging')
    }
    const icon = clampIcon(dragOrigin.left + dx, dragOrigin.top + dy)
    currentPos = iconToPos(icon)
    placeIcon(host, icon)
  })

  const endDrag = (event: PointerEvent): void => {
    if (dragPointerId !== event.pointerId) return
    dragPointerId = null
    try {
      button.releasePointerCapture(event.pointerId)
    } catch {
      /* already released or the pointer is gone */
    }
    if (!dragged) return
    button.classList.remove('dragging')
    if (currentPos) {
      void chrome.runtime
        .sendMessage({ type: 'floating.move', x: currentPos.x, y: currentPos.y })
        .catch(() => {})
    }
  }
  button.addEventListener('pointerup', endDrag)
  button.addEventListener('pointercancel', endDrag)

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    // A drag ends with a click on the same element — swallow it so dropping
    // the button never reopens the panel; the flag resets on the next press.
    if (dragged) {
      dragged = false
      return
    }
    // Do NOT unmount optimistically: the worker only retires the minimized
    // mark (and broadcasts `floating.hide`) once `sidePanel.open` actually
    // succeeded. If the open is rejected (e.g. the user-gesture race right
    // after a worker wake), the window stays so the click can simply be
    // repeated instead of leaving the plugin unreachable on this page.
    void chrome.runtime.sendMessage({ type: 'floating.expand' }).catch(() => {})
  })

  document.documentElement.appendChild(host)
  ownedHost = host
  detachCleanup = () => {
    sizeWatch?.disconnect()
    window.removeEventListener('resize', onResize)
  }
}

function unmount(): void {
  if (!isActiveInstance()) return
  detachCleanup?.()
  detachCleanup = null
  dropStaleHosts()
  ownedHost?.remove()
  ownedHost = null
}

// Initial state: render when this window's plugin is minimized. The worker
// answers quickly; a rejection (worker cold-start race, extension reload)
// just means no window until a later `floating.show`.
void chrome.runtime
  .sendMessage({ type: 'floating.status' })
  .then((response: unknown) => {
    const status = response as { minimized?: boolean; pos?: ButtonPos } | undefined
    if (status?.minimized) mount(status.pos)
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
    if (!isActiveInstance()) return
    const msg = message as { type?: string; pos?: ButtonPos } | undefined
    if (msg?.type === 'floating.show') mount(msg.pos)
    else if (msg?.type === 'floating.hide') unmount()
    else return
    // Every content script of this extension hears each tab message, so a
    // resolved send only proves SOME listener exists. The worker reinjects
    // this script on a missing receipt; answering marks this as the receiver.
    sendResponse({ ok: true })
  },
)

// Import-free by design, but a module so tests can import its listeners.
export {}
