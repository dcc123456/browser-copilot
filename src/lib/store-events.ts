/**
 * Change notifications for the persistent stores.
 *
 * `chrome.storage.onChanged` used to carry these for free: every write was
 * mirrored into `chrome.storage.local`, so a change made anywhere — the service
 * worker, another window's panel, or a sibling tab of the same panel — fired an
 * event in every listener. File-backed storage deliberately no longer writes
 * that mirror (the user asked for their data to live in the chosen directory
 * and nowhere else), so the notification is emitted explicitly instead.
 *
 * Two channels are needed, and neither is sufficient alone:
 * - `chrome.runtime.sendMessage` reaches the other extension contexts, but
 *   Chrome deliberately skips the sender's own frame — and the panel's tabs
 *   (Chat, Workflows, Settings) all live in one frame.
 * - A `window` CustomEvent covers exactly that same-frame case. It is absent in
 *   the service worker, which has no UI to refresh anyway.
 *
 * Both are fire-and-forget: a notification that nobody hears costs at most a
 * refresh that happens on the next poll or panel open, and can never lose a
 * write. Listeners re-read the store themselves — the notification carries the
 * key that changed, never the value, so a listener cannot act on a stale copy.
 *
 * @module lib/store-events
 */

/** Runtime-message type carrying a store change across extension contexts. */
export const STORE_CHANGED = 'store.changed'

/** `window` event name carrying a store change within a single frame. */
const STORE_CHANGED_EVENT = 'bcopilot:store-changed'

/** Payload pushed over `chrome.runtime` for {@link STORE_CHANGED}. */
export interface StoreChangedMessage {
  type: typeof STORE_CHANGED
  /** The storage key that changed, e.g. `'workflows'` or `'settings'`. */
  key: string
}

function isStoreChangedMessage(value: unknown): value is StoreChangedMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<StoreChangedMessage>
  return message.type === STORE_CHANGED && typeof message.key === 'string'
}

/**
 * Announces that `key` changed. Never throws: there may be no listener at all
 * (no panel open), which is harmless by construction.
 */
export function notifyStoreChanged(key: string): void {
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(STORE_CHANGED_EVENT, { detail: key }))
    } catch {
      // No `CustomEvent` on this host — the runtime channel still fires.
    }
  }
  try {
    const message: StoreChangedMessage = { type: STORE_CHANGED, key }
    void chrome?.runtime?.sendMessage(message)?.catch(() => undefined)
  } catch {
    // `chrome.runtime` is unavailable (tests, a plain page) — nothing to notify.
  }
}

/**
 * Subscribes to changes of `key` on both channels and returns an unsubscribe
 * function. Listeners must re-read the store; see the module note.
 */
export function onStoreChanged(key: string, handler: () => void): () => void {
  const onLocal = (event: Event): void => {
    if ((event as CustomEvent<string>).detail === key) handler()
  }
  const onRuntime = (message: unknown): void => {
    if (isStoreChangedMessage(message) && message.key === key) handler()
  }

  if (typeof window !== 'undefined') window.addEventListener(STORE_CHANGED_EVENT, onLocal)
  try {
    chrome?.runtime?.onMessage?.addListener(onRuntime)
  } catch {
    // No runtime — the window channel above still works.
  }

  return () => {
    if (typeof window !== 'undefined') window.removeEventListener(STORE_CHANGED_EVENT, onLocal)
    try {
      chrome?.runtime?.onMessage?.removeListener(onRuntime)
    } catch {
      // Already torn down.
    }
  }
}
