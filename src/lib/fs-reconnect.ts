/**
 * Automatic re-grant of the storage directory's file permission.
 *
 * Chrome treats an extension update (or a reload of an unpacked build) as new
 * code: the read/write permission previously granted for the storage directory
 * is dropped and the handle's permission state falls back to `'prompt'`.
 * Re-granting is a platform security requirement — `requestPermission` needs a
 * window plus transient user activation, so the service worker can never do it
 * and a page can only do it inside a real user interaction. Until that happens
 * the persistence layer parks writes in the outbox (`lib/fs-outbox.ts`) and
 * reads fall back to the cache, which is why the settings row asks for a
 * manual "reconnect folder" after every update.
 *
 * This module makes the re-grant feel automatic: it checks the configured
 * folder when the panel opens, retries on every user interaction (a click or
 * keypress inside the panel provides the gesture Chrome requires), when the
 * panel becomes visible again, when the window regains focus, and whenever a
 * write reports that the folder became unreachable. It stays armed for the
 * whole page lifetime — a folder granted once can lose its permission again
 * (Chrome ties a non-persistent grant to the document), so disarming after the
 * first success is exactly the hole that made sessions go quietly stale.
 *
 * When Chrome decides to show its native "allow access" bubble, confirming
 * that once is the part the platform mandates and cannot be skipped.
 *
 * @module lib/fs-reconnect
 */
import {
  ensureFileAccess,
  getStorageMode,
  isStorageDirectoryConfigured,
  resetStorageCache,
  STORAGE_DIRECTORY_CHANGED,
  STORAGE_DISCONNECTED_EVENT,
  STORAGE_DISCONNECTED_MESSAGE,
} from './fs-store'

/**
 * Fired on `window` after the configured folder transitions from unreachable
 * back to connected (or after the configured folder itself changed). Lets open
 * surfaces (the settings storage row, the data tabs) refresh without a remount.
 */
export const STORAGE_RECONNECTED_EVENT = 'bc:storage-reconnected'

/**
 * One reconnection attempt. Connects the configured folder when its permission
 * is merely pending — `ensureFileAccess` calls `requestPermission`, which only
 * succeeds inside a user gesture — and flushes the outbox on success. Returns
 * the resulting storage mode; `'browser'` also covers "no folder configured".
 */
export async function reconnectStorageFolder(): Promise<'file' | 'browser'> {
  if (!(await isStorageDirectoryConfigured())) return 'browser'
  return ensureFileAccess()
}

/** Gesture events that grant transient user activation in a page. */
const GESTURE_EVENTS = ['pointerdown', 'keydown'] as const

/**
 * How often a click re-checks an already-connected folder. Permission loss is
 * rare mid-document but cheap to notice ({@link getStorageMode} only queries
 * the cached handle); the throttle keeps it off every keystroke and click.
 */
const CONNECTED_RECHECK_MS = 5_000

/**
 * Starts the auto-reconnect: one immediate attempt, then another on every
 * user interaction, panel visibility change (to visible), window focus, and
 * storage-disconnect report until the page goes away. The gesture listeners
 * sit on the window in the capture phase (before React's handlers) and are
 * passive, so they never interfere with the click that triggered them.
 *
 * Returns a teardown suitable for a React effect's cleanup.
 */
export function autoReconnectStorage(): () => void {
  if (typeof window === 'undefined') return () => undefined
  let disposed = false
  let inFlight = false
  /** Configured but not connected as of the last observation. */
  let wasDisconnected = false
  /** A write reported the folder unreachable since the last successful check. */
  let needsRetry = true
  let lastCheck = 0

  const removeListeners = (): void => {
    for (const type of GESTURE_EVENTS) {
      window.removeEventListener(type, onGesture, true)
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener(STORAGE_DISCONNECTED_EVENT, onLocalDisconnected)
    try {
      chrome?.runtime?.onMessage?.removeListener(onRuntimeMessage)
    } catch {
      // No runtime in this context.
    }
  }

  const dispose = (): void => {
    disposed = true
    removeListeners()
  }

  const onGesture = (): void => {
    // While connected, a throttled re-check is enough; while not, every
    // interaction is an opportunity to supply the activation Chrome needs.
    if (!needsRetry && Date.now() - lastCheck < CONNECTED_RECHECK_MS) return
    void attempt(false)
  }

  /** A side panel that was hidden (window switched, minimized) is back. */
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void attempt(true)
  }

  /** The window regained focus — e.g. the user returned from the browser UI. */
  const onFocus = (): void => {
    void attempt(true)
  }

  /** A write parked because the folder could not be reached. */
  const onLocalDisconnected = (): void => {
    needsRetry = true
    lastCheck = 0
  }

  /**
   * Cross-context report: another frame (usually the worker) parked a write, or
   * the configured folder changed. The latter also invalidates this frame's
   * handle cache — without it a second panel would keep reading the old folder.
   */
  const onRuntimeMessage = (message: unknown): void => {
    const type = (message as { type?: unknown } | undefined)?.type
    if (type === STORAGE_DISCONNECTED_MESSAGE) {
      // Re-emit locally so the settings row / data tabs in THIS frame refresh.
      onLocalDisconnected()
      window.dispatchEvent(new Event(STORAGE_DISCONNECTED_EVENT))
      void attempt(false)
      return
    }
    if (type === STORAGE_DIRECTORY_CHANGED) {
      resetStorageCache()
      wasDisconnected = true
      needsRetry = true
      lastCheck = 0
      void attempt(true)
    }
  }

  const attempt = async (force: boolean): Promise<void> => {
    if (disposed || inFlight) return
    if (!force && Date.now() - lastCheck < CONNECTED_RECHECK_MS && !needsRetry) return
    inFlight = true
    lastCheck = Date.now()
    try {
      if (!(await isStorageDirectoryConfigured())) {
        // Nothing to reconnect (yet). Stay armed: the user may pick a folder
        // later in this same document.
        wasDisconnected = false
        needsRetry = false
        return
      }
      let mode = await getStorageMode()
      if (mode !== 'file') {
        wasDisconnected = true
        mode = await ensureFileAccess()
      }
      if (mode === 'file') {
        needsRetry = false
        if (wasDisconnected) {
          wasDisconnected = false
          window.dispatchEvent(new CustomEvent(STORAGE_RECONNECTED_EVENT))
        }
      } else {
        // Still 'browser': the gesture was missing (background/visibility
        // checks) or Chrome denied the prompt. Stay armed; the next real
        // interaction retries.
        needsRetry = true
      }
    } catch {
      // Reconnection must never break the interaction that triggered it.
      // Stays parked; the next interaction retries.
      needsRetry = true
    } finally {
      inFlight = false
    }
  }

  for (const type of GESTURE_EVENTS) {
    window.addEventListener(type, onGesture, { capture: true, passive: true })
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onFocus)
  window.addEventListener(STORAGE_DISCONNECTED_EVENT, onLocalDisconnected)
  try {
    chrome?.runtime?.onMessage?.addListener(onRuntimeMessage)
  } catch {
    // No runtime in this context.
  }
  void attempt(true)

  return () => {
    dispose()
  }
}
