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
 *    the button immediately (covers navigation / new tabs while minimized).
 *  - `floating.show` / `floating.hide` (broadcast by the worker) toggle it
 *    live on already-loaded tabs. Tabs that predate the extension load have
 *    no receiver for the broadcast — the worker injects this script into
 *    them on demand, and the boot-time `floating.status` query then mounts
 *    the button by itself.
 *  - Click sends `floating.expand`; the worker opens the side panel and only
 *    then clears the minimized mark and broadcasts `floating.hide` to every
 *    reopens the side panel (the click gesture is what authorizes the open).
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

function iconUrl(): string {
  try {
    return chrome.runtime.getURL(ICON_PATH)
  } catch {
    return ''
  }
}

function mount(): void {
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
      }
      button:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.35);
      }
      button:active { transform: scale(0.96); }
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

  shadow.querySelector('button')?.addEventListener('click', (event) => {
    event.stopPropagation()
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
  document.getElementById(HOST_ID)?.remove()
}

// Initial state: render when this window's plugin is minimized. The worker
// answers quickly; a rejection (worker cold-start race, extension reload)
// just means no button until a later `floating.show`.
void chrome.runtime
  .sendMessage({ type: 'floating.status' })
  .then((response: unknown) => {
    if ((response as { minimized?: boolean } | undefined)?.minimized) mount()
  })
  .catch(() => {})

chrome.runtime.onMessage.addListener((message: unknown) => {
  const type = (message as { type?: string } | undefined)?.type
  if (type === 'floating.show') mount()
  else if (type === 'floating.hide') unmount()
})
