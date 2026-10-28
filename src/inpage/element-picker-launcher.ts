/**
 * On-page element-picker launcher.
 *
 * A static content script parked on every http(s) page. It stays inert until
 * the `elementPickerEnabled` setting is on — the worker's boot reply
 * (`elementPicker.status`) and its `elementPicker.set` broadcasts decide.
 * Clicking the crosshair button starts the shared picker in `copy` mode: the
 * user picks an element and the payload picked in Settings (CSS selector,
 * visible text, or outerHTML) is copied to the clipboard for pasting into the
 * chat.
 *
 * The setting is answered by the worker rather than read here: settings may
 * live in a user-chosen folder that content scripts cannot access.
 *
 * One floating window: while the minimized plugin's icon is on the page, this
 * button docks into that window (a light-DOM child of its host, rendered
 * through the host's `<slot>`) so the pair is a single box that drags and
 * flips together. With the panel open there is no such window and the button
 * parks in the bottom-right corner on its own.
 *
 * The button lives in a Shadow DOM so page CSS cannot restyle it, and the host
 * never intercepts page events outside the button itself. Like the floating
 * button this is a bundled static content script, so importing the picker is
 * fine; everything else stays dependency-free.
 *
 * @module inpage/element-picker-launcher
 */

import type {
  ElementPickerControl,
  ElementPickerLauncherMessage,
  ElementPickerStatusResponse,
} from '../lib/messages'
import { startPicker } from './element-picker'

const HOST_ID = 'bc-element-picker-launcher'
const FLOATING_HOST_ID = 'browser-copilot-floating-host'
/** Sent by floating-button when its window mounts; kept in sync there. */
const DOCK_REQUEST_EVENT = 'bc:floating-window-ready'
const PICKER_ID = 'element-picker'
const EDGE = 16
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
// The isolated world outlives the reinjection, so a token stored there tells a
// live instance from a dead one.
const INSTANCE: object = {}
const ownerScope = globalThis as { __bcPickerLauncherInstance?: object }
ownerScope.__bcPickerLauncherInstance = INSTANCE
const isActiveInstance = (): boolean => ownerScope.__bcPickerLauncherInstance === INSTANCE

let ownedHost: HTMLElement | null = null

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

function createHost(): HTMLElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.all = 'initial'
  host.style.position = 'fixed'
  host.style.right = `${EDGE}px`
  host.style.bottom = `${EDGE}px`
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
    <button type="button">${BUTTON_ICON}</button>
  `

  const button = shadow.querySelector('button')
  button?.addEventListener('click', (event) => {
    event.stopPropagation()
    // A second click while the picker is open would stack listeners on the
    // same document; the open card is the signal to wait.
    if (document.getElementById('bc-element-picker')) return
    void startPicker({ pickerId: PICKER_ID, mode: 'copy', copyFormat, locale, selectOnly })
  })
  return host
}

/**
 * Removes every crosshair host this live instance does not own: a dead
 * predecessor may have left one (or a nested duplicate) behind, and adopting
 * it would keep an inert button on the page.
 */
function dropStaleHosts(): void {
  for (const host of document.querySelectorAll(`#${HOST_ID}`)) {
    if (host !== ownedHost) host.remove()
  }
}

/** Docks into the plugin window when it exists, otherwise parks alone. */
function mount(): void {
  if (!isActiveInstance()) return
  dropStaleHosts()

  // A docked host dies with the window it was slotted into; rebuild it.
  if (!ownedHost || !ownedHost.isConnected) ownedHost = createHost()

  const floating = document.getElementById(FLOATING_HOST_ID)
  if (floating && floating !== ownedHost) {
    if (ownedHost.parentElement !== floating) floating.appendChild(ownedHost)
    ownedHost.style.display = 'block'
    ownedHost.style.position = 'static'
    ownedHost.style.right = ''
    ownedHost.style.bottom = ''
    ownedHost.style.left = ''
    ownedHost.style.top = ''
  } else {
    if (ownedHost.parentElement !== document.documentElement) {
      document.documentElement.appendChild(ownedHost)
    }
    ownedHost.style.display = 'block'
    ownedHost.style.position = 'fixed'
    ownedHost.style.right = `${EDGE}px`
    ownedHost.style.bottom = `${EDGE}px`
  }
  applyLabel()
}

function unmount(): void {
  if (!isActiveInstance()) return
  dropStaleHosts()
  ownedHost?.remove()
  ownedHost = null
}

// The plugin window mounts, unmounts and gets replaced as the panel minimizes
// and expands; re-dock whenever a direct child of <html> changes.
new MutationObserver(() => {
  if (enabled) mount()
}).observe(document.documentElement, { childList: true })

// Answer the window's dock request synchronously. The window uses the answer to
// tell a live crosshair (docks now) from one a dead script left behind (does
// not answer, so it is dropped instead of staying stuck in the corner).
document.addEventListener(DOCK_REQUEST_EVENT, () => {
  if (enabled) mount()
})

/** Boot: the worker knows both the toggle and the storage area it lives in. */
void chrome.runtime
  .sendMessage({ type: 'elementPicker.status' } satisfies ElementPickerLauncherMessage)
  .then((response: unknown) => {
    const status = response as ElementPickerStatusResponse | undefined
    locale = status?.locale === 'zh' ? 'zh' : 'en'
    copyFormat = copyFormatOf(status?.format)
    selectOnly = status?.selectOnly === true
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
    // Receipt for the worker's injection fallback: the floating button's
    // listener would otherwise make `sendMessage` look delivered in a tab
    // where this script was never injected.
    sendResponse({ ok: true })
  },
)
