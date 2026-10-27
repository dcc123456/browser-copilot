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
const PICKER_ID = 'element-picker'
const BUTTON_SIZE = 40
const GAP = 8
const EDGE = 16
const BUTTON_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>'

type PickerLocale = 'en' | 'zh'
type CopyFormat = ElementPickerControl['format']

let locale: PickerLocale = 'en'
let copyFormat: CopyFormat = 'html'

function copyFormatOf(value: unknown): CopyFormat {
  return value === 'selector' || value === 'text' ? value : 'html'
}

function label(): string {
  return locale === 'zh' ? '选择页面元素并复制' : 'Pick a page element and copy it'
}

function launcherButton(): HTMLButtonElement | null {
  const host = document.getElementById(HOST_ID)
  return (host?.shadowRoot?.querySelector('button') as HTMLButtonElement | null) ?? null
}

function applyLabel(): void {
  const button = launcherButton()
  if (!button) return
  button.title = label()
  button.setAttribute('aria-label', label())
}

function unmount(): void {
  document.getElementById(HOST_ID)?.remove()
}

/**
 * Keeps the crosshair clear of the plugin's restore button: the floating button
 * is draggable and its saved position may sit wherever the crosshair used to
 * be, which hid one button behind the other. Anchored below it (flipped above
 * near the bottom edge), defaulting to the old spot when the panel is open.
 */
function place(host: HTMLElement): void {
  host.style.right = `${EDGE}px`
  const floating = document.getElementById(FLOATING_HOST_ID)
  if (!floating) {
    host.style.top = 'calc(50% + 28px)'
    return
  }
  const rect = floating.getBoundingClientRect()
  host.style.right = `${Math.max(EDGE, Math.round(window.innerWidth - rect.right))}px`
  let top = Math.round(rect.bottom + GAP)
  if (top + BUTTON_SIZE > window.innerHeight - EDGE) {
    top = Math.round(rect.top - GAP - BUTTON_SIZE)
  }
  host.style.top = `${Math.max(EDGE, top)}px`
}

function placeLauncher(): void {
  const host = document.getElementById(HOST_ID)
  if (host instanceof HTMLElement) place(host)
}

let floatingWatch: MutationObserver | null = null

/** Follow the floating button's mount, unmount and drag without polling. */
function watchFloating(): void {
  floatingWatch?.disconnect()
  floatingWatch = null
  const floating = document.getElementById(FLOATING_HOST_ID)
  if (!floating) return
  floatingWatch = new MutationObserver(placeLauncher)
  floatingWatch.observe(floating, { attributes: true, attributeFilter: ['style'] })
}

function mount(): void {
  if (!document.getElementById(HOST_ID)) {
    const host = document.createElement('div')
    host.id = HOST_ID
    host.style.all = 'initial'
    host.style.position = 'fixed'
    host.style.zIndex = '2147483647'
    host.style.pointerEvents = 'none'

    place(host)
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
    if (!button) return
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      // A second click while the picker is open would stack listeners on the
      // same document; the open card is the signal to wait.
      if (document.getElementById('bc-element-picker')) return
      void startPicker({ pickerId: PICKER_ID, mode: 'copy', copyFormat, locale })
    })

    document.documentElement.appendChild(host)
    watchFloating()
  }
  applyLabel()
  placeLauncher()
}

window.addEventListener('resize', placeLauncher)

// The floating button mounts/unmounts as the panel minimizes/expands; re-anchor
// whenever a direct child of <html> changes (cheap: subtree is not observed).
new MutationObserver(() => {
  watchFloating()
  placeLauncher()
}).observe(document.documentElement, { childList: true })

/** Boot: the worker knows both the toggle and the storage area it lives in. */
void chrome.runtime
  .sendMessage({ type: 'elementPicker.status' } satisfies ElementPickerLauncherMessage)
  .then((response: unknown) => {
    const status = response as ElementPickerStatusResponse | undefined
    locale = status?.locale === 'zh' ? 'zh' : 'en'
    copyFormat = copyFormatOf(status?.format)
    if (status?.enabled) mount()
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as Partial<ElementPickerControl> | undefined
  if (msg?.type !== 'elementPicker.set') return
  locale = msg.locale === 'zh' ? 'zh' : 'en'
  copyFormat = copyFormatOf(msg.format)
  if (msg.enabled) mount()
  else unmount()
})
