/**
 * Minimized side-panel state.
 *
 * "Minimize" collapses the side panel into a floating button on the page.
 * The Chrome side panel is closed in the process, which disconnects the
 * panel port — so the panel-window registry in `automation-scope.ts` stops
 * listing the window exactly when the user still considers the plugin
 * "open". This module is the second half of that registry: windows whose
 * plugin is running minimized. Together they form the "plugin windows" set
 * (`automation-scope.isPluginWindow`) that unattended runs are confined to.
 *
 * State lives in module scope for synchronous reads and is mirrored to
 * `chrome.storage.session` so a service-worker eviction does not silently
 * turn a minimized window into a "closed" one mid-session. Session storage
 * (not local) is deliberate: a browser restart also resets the side panel
 * to closed, so a stale minimized mark would keep a window the user has not
 * re-opened the plugin in under automation.
 *
 * @module background/panel-minimize
 */

/** windowId → epoch ms when the window was minimized (insertion = order). */
const minimizedWindows = new Map<number, number>()

const SESSION_KEY = 'minimizedWindows'

/** Best-effort mirror into session storage; failures are non-fatal. */
function persist(): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return
  const ids = [...minimizedWindows.keys()]
  void chrome.storage.session.set({ [SESSION_KEY]: ids }).catch(() => {})
}

/**
 * Marks a window's plugin as minimized. Idempotent: re-minimizing keeps the
 * original order position (the window was already not freshly minimized).
 */
export function minimizeWindow(windowId: number): void {
  if (typeof windowId !== 'number') return
  if (minimizedWindows.has(windowId)) return
  minimizedWindows.set(windowId, Date.now())
  persist()
}

/** Clears the minimized mark (the panel is open again, or the window died). */
export function expandWindow(windowId: number): void {
  if (typeof windowId !== 'number') return
  if (!minimizedWindows.delete(windowId)) return
  persist()
}

/** Whether the plugin in this window is currently minimized. */
export function isMinimized(windowId: number | undefined): boolean {
  return typeof windowId === 'number' && minimizedWindows.has(windowId)
}

/** Minimized window ids, oldest minimization first. */
export function listMinimizedWindowIds(): number[] {
  return [...minimizedWindows.keys()]
}

/**
 * Resolves once the session-state restore has been applied. Callers that
 * answer "is this window minimized?" from an event that itself woke the
 * worker (content-script `floating.status`) must wait for it: the restore is
 * asynchronous, and answering before it lands reports a stale `false`, which
 * leaves the minimized plugin without its floating button on the new page.
 */
let restoreSettled: Promise<void> = Promise.resolve()

export function whenRestoreSettled(): Promise<void> {
  return restoreSettled
}

/**
 * Restores the mirrored state after a worker restart and drops marks for
 * windows that no longer exist. Safe to call multiple times / in tests
 * (guarded when `chrome` is unavailable).
 */
export function initPanelMinimize(): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return

  restoreSettled = chrome.storage.session
    .get(SESSION_KEY)
    .then((stored) => {
      const ids = stored?.[SESSION_KEY]
      if (!Array.isArray(ids)) return
      for (const id of ids) {
        if (typeof id === 'number') minimizedWindows.set(id, Date.now())
      }
      // The worker may have been down while a window was closed; validate.
      return Promise.all(
        [...minimizedWindows.keys()].map(async (id) => {
          const exists = await chrome.windows
            .get(id)
            .then(() => true)
            .catch(() => false)
          if (!exists) minimizedWindows.delete(id)
        }),
      ).then(() => persist())
    })
    .catch(() => {})

  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener((closedWindowId) => {
      expandWindow(closedWindowId)
    })
  }
}

/** Test helper: clears all tracked state. */
export function _resetMinimizeForTests(): void {
  minimizedWindows.clear()
  restoreSettled = Promise.resolve()
}
