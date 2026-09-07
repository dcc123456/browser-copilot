/**
 * Floating button for the minimized plugin.
 *
 * A static content script parked on every http(s) page. It renders nothing
 * until the service worker says the plugin in THIS window is minimized —
 * then the collapsed side panel is represented by a single floating button
 * that reopens it on click.
 *
 * Lifecycle:
 *  - On load the script asks `floating.status`; a minimized window renders
 *    the button immediately (covers navigation / new tabs while minimized),
 *    at the window's saved drag position when one exists.
 *  - `floating.show` / `floating.hide` (broadcast by the worker) toggle it
 *    live on already-loaded tabs; `floating.show` carries the saved position.
 *    Tabs that predate the extension load have no receiver for the broadcast
 *    — the worker injects this script into them on demand, and the boot-time
 *    `floating.status` query then mounts the button by itself.
 *  - Click sends `floating.expand`; the worker opens the side panel and only
 *    then clears the minimized mark and broadcasts `floating.hide` to every
 *    page of the window (the click gesture is what authorizes the open).
 *  - Dragging moves the button anywhere in the viewport; on drop the position
 *    is persisted per window (`floating.move` → worker → chrome.storage) so
 *    every page of this window remounts the button where it was dropped.
 *
 * The button lives in a Shadow DOM so page CSS cannot restyle it, and the
 * overlay never intercepts page events outside the button itself. It is a
 * bundled static content script, so unlike the serialized element picker it
 * MAY import shared modules — keep this file dependency-free anyway, it runs
 * in every frame of every page.
 *
 * @module inpage/floating-button
 */

const HOST_ID = 'browser-copilot-floating-host'
const ICON_PATH = 'icons/icon-48.png'
/** Square button edge in px (must match the shadow style below). */
const BUTTON_SIZE = 40
/** Minimum distance the button keeps from the viewport edges, in px. */
const VIEWPORT_MARGIN = 8
/** Pointer travel below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4

/** A dropped position: the button CENTER in viewport percents (0–100). */
interface ButtonPos {
  x: number
  y: number
}

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

/** Percent position → top-left px, kept fully inside the current viewport. */
function posToLeftTop(pos: ButtonPos): { left: number; top: number } {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN)
  return {
    left: clamp((pos.x / 100) * window.innerWidth - BUTTON_SIZE / 2, VIEWPORT_MARGIN, maxLeft),
    top: clamp((pos.y / 100) * window.innerHeight - BUTTON_SIZE / 2, VIEWPORT_MARGIN, maxTop),
  }
}

/** Inverse: a top-left px placement → center percent position. */
function leftTopToPos(left: number, top: number): ButtonPos {
  return {
    x: ((left + BUTTON_SIZE / 2) / Math.max(1, window.innerWidth)) * 100,
    y: ((top + BUTTON_SIZE / 2) / Math.max(1, window.innerHeight)) * 100,
  }
}

/** Pins the host at the given position (drops the default right/center anchoring). */
function applyPos(host: HTMLElement, pos: ButtonPos): void {
  const { left, top } = posToLeftTop(pos)
  host.style.left = `${left}px`
  host.style.top = `${top}px`
  host.style.right = 'auto'
  host.style.transform = 'none'
}

let resizeCleanup: (() => void) | null = null

function mount(pos?: ButtonPos): void {
  if (document.getElementById(HOST_ID)) return
  const host = document.createElement('div')
  host.id = HOST_ID
  // Reset anything the page inherits onto the host element itself.
  host.style.all = 'initial'
  host.style.position = 'fixed'
  host.style.right = '16px'
  host.style.top = '50%'
  host.style.transform = 'translateY(-50%)'
  host.style.zIndex = '2147483647'
  host.style.pointerEvents = 'none'

  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
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
    <button type="button" title="Browser Copilot" aria-label="Browser Copilot">
      <img alt="" draggable="false" />
    </button>
  `

  const img = shadow.querySelector('img')
  const src = iconUrl()
  if (img && src) img.src = src
  const button = shadow.querySelector('button')
  if (!button) {
    host.remove()
    return
  }

  // Restore the saved position (boot-time status reply or a floating.show
  // broadcast both carry it), and keep it on-screen across window resizes.
  let currentPos = pos ?? null
  if (currentPos) applyPos(host, currentPos)
  const onResize = (): void => {
    if (currentPos) applyPos(host, currentPos)
  }
  window.addEventListener('resize', onResize)
  resizeCleanup = () => window.removeEventListener('resize', onResize)

  // --- drag to move ----------------------------------------------------------
  // pointerdown → capture on the button; travel beyond the threshold turns the
  // press into a drag (reposition live, clamp inside the viewport); on drop the
  // position is persisted per window. A press that never crossed the threshold
  // stays a click (expand). The click listener below swallows the click event
  // that follows a real drag.
  let dragPointerId: number | null = null
  let dragStart = { x: 0, y: 0 }
  let dragOrigin = { left: 0, top: 0 }
  let dragged = false

  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return
    const rect = host.getBoundingClientRect()
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
    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN,
    )
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN,
    )
    const left = clamp(dragOrigin.left + dx, VIEWPORT_MARGIN, maxLeft)
    const top = clamp(dragOrigin.top + dy, VIEWPORT_MARGIN, maxTop)
    currentPos = leftTopToPos(left, top)
    applyPos(host, currentPos)
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
    // after a worker wake), the button stays so the click can simply be
    // repeated instead of leaving the plugin unreachable on this page.
    void chrome.runtime.sendMessage({ type: 'floating.expand' }).catch(() => {})
  })

  document.documentElement.appendChild(host)
}

function unmount(): void {
  resizeCleanup?.()
  resizeCleanup = null
  document.getElementById(HOST_ID)?.remove()
}

// Initial state: render when this window's plugin is minimized. The worker
// answers quickly; a rejection (worker cold-start race, extension reload)
// just means no button until a later `floating.show`.
void chrome.runtime
  .sendMessage({ type: 'floating.status' })
  .then((response: unknown) => {
    const status = response as { minimized?: boolean; pos?: ButtonPos } | undefined
    if (status?.minimized) mount(status.pos)
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; pos?: ButtonPos } | undefined
  if (msg?.type === 'floating.show') mount(msg.pos)
  else if (msg?.type === 'floating.hide') unmount()
})
