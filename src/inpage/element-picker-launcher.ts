/**
 * On-page element-picker launcher.
 *
 * A static content script parked on every http(s) page. It stays inert until
 * the `elementPickerEnabled` setting is on — the worker's boot reply
 * (`elementPicker.status`) and its `elementPicker.set` broadcasts decide.
 * Clicking the crosshair button starts the shared picker in `html` mode: the
 * user picks an element and its outerHTML is copied to the clipboard for
 * pasting into the chat.
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
const PICKER_ID = 'element-picker-html'
const BUTTON_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>'

type PickerLocale = 'en' | 'zh'

let locale: PickerLocale = 'en'

function label(): string {
  return locale === 'zh' ? '选择页面元素并复制其 HTML' : 'Pick a page element and copy its HTML'
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

function mount(): void {
  if (!document.getElementById(HOST_ID)) {
    const host = document.createElement('div')
    host.id = HOST_ID
    host.style.all = 'initial'
    host.style.position = 'fixed'
    host.style.right = '16px'
    host.style.top = 'calc(50% + 28px)'
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
      void startPicker({ pickerId: PICKER_ID, mode: 'html', locale })
    })

    document.documentElement.appendChild(host)
  }
  applyLabel()
}

/** Boot: the worker knows both the toggle and the storage area it lives in. */
void chrome.runtime
  .sendMessage({ type: 'elementPicker.status' } satisfies ElementPickerLauncherMessage)
  .then((response: unknown) => {
    const status = response as ElementPickerStatusResponse | undefined
    locale = status?.locale === 'zh' ? 'zh' : 'en'
    if (status?.enabled) mount()
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as Partial<ElementPickerControl> | undefined
  if (msg?.type !== 'elementPicker.set') return
  locale = msg.locale === 'zh' ? 'zh' : 'en'
  if (msg.enabled) mount()
  else unmount()
})
