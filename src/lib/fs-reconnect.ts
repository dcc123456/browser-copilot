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
 * This module makes the re-grant feel automatic: when the panel opens it
 * checks the configured folder, tries to connect immediately (covers the rare
 * case where activation is somehow available), and otherwise retries on the
 * panel's FIRST user interaction — any click or keypress provides the gesture
 * Chrome requires, so the folder reconnects without a trip to Settings. When
 * Chrome decides to show its native "allow access" bubble, confirming that
 * once is the part the platform mandates and cannot be skipped.
 *
 * @module lib/fs-reconnect
 */
import { ensureFileAccess, getStorageMode, isStorageDirectoryConfigured } from './fs-store'

/**
 * Fired on `window` after the configured folder transitions from unreachable
 * back to connected. Lets open surfaces (the settings storage row) refresh
 * without a remount.
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
 * Starts the auto-reconnect: one immediate attempt, then another on every
 * user interaction until the folder is connected. The listeners sit on the
 * window in the capture phase (before React's handlers) and are passive, so
 * they never interfere with the click that triggered them.
 *
 * Returns a teardown suitable for a React effect's cleanup. When no folder is
 * configured, or the folder is already connected (the normal restart case),
 * the attempt disarms itself instead of listening forever.
 */
export function autoReconnectStorage(): () => void {
  if (typeof window === 'undefined') return () => undefined
  let disposed = false
  let inFlight = false

  const onGesture = (): void => {
    void attempt()
  }

  const removeListeners = (): void => {
    for (const type of GESTURE_EVENTS) {
      window.removeEventListener(type, onGesture, true)
    }
  }

  /** The single disarm path: used by success, by no-op states, and by teardown. */
  const dispose = (): void => {
    disposed = true
    removeListeners()
  }

  const attempt = async (): Promise<void> => {
    if (disposed || inFlight) return
    inFlight = true
    try {
      if (!(await isStorageDirectoryConfigured())) {
        // Nothing to reconnect — the user has not picked a folder at all.
        dispose()
        return
      }
      if ((await getStorageMode()) === 'file') {
        // Already granted: the normal state after a browser restart. Nothing
        // changed, so no event is needed either.
        dispose()
        return
      }
      const mode = await ensureFileAccess()
      if (mode === 'file') {
        window.dispatchEvent(new CustomEvent(STORAGE_RECONNECTED_EVENT))
        dispose()
      }
      // Still 'browser': the gesture was missing (the immediate attempt) or
      // Chrome denied the prompt. Listeners stay armed; the next interaction
      // retries, and picking the folder again also disarms via 'file' mode.
    } catch {
      // Reconnection must never break the interaction that triggered it.
      // Stays parked; the next interaction retries.
    } finally {
      inFlight = false
    }
  }

  for (const type of GESTURE_EVENTS) {
    window.addEventListener(type, onGesture, { capture: true, passive: true })
  }
  void attempt()

  return () => {
    dispose()
  }
}
