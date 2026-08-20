/**
 * Keeps the service worker alive while real work is in flight.
 *
 * ## The problem
 *
 * Chrome evicts an idle MV3 worker after ~30 seconds. The panel's port heartbeat
 * covers the case where the panel is open, but the user explicitly wants to
 * collapse the panel and let the agent keep working — and closing the panel
 * destroys the port, removing exactly that protection. A `chrome.alarms` tick
 * cannot substitute: packed extensions are clamped to a 1-minute floor, which is
 * far too coarse to prevent a 30-second eviction.
 *
 * ## The mechanism
 *
 * Any extension API call resets the idle timer, so a short periodic no-op call
 * (`chrome.runtime.getPlatformInfo`) holds the worker open. This is the standard
 * MV3 keepalive technique.
 *
 * It is deliberately **reference-counted and strictly scoped to active work**: a
 * worker pinned open forever would drain battery and defeat the point of the MV3
 * lifecycle. `retain()`/`release()` are balanced in a `finally`, so a crashing
 * turn still lets the worker go idle.
 *
 * @module background/keepalive
 */

/** Comfortably inside Chrome's ~30s idle eviction window. */
const KEEPALIVE_INTERVAL_MS = 20_000

/**
 * Absolute cap on how long the worker may be held open.
 *
 * A stuck stream must not pin the worker indefinitely; the turn itself is also
 * bounded, so hitting this means something already went wrong.
 */
const MAX_HOLD_MS = 10 * 60 * 1000

let holders = 0
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0

function tick(): void {
  if (Date.now() - startedAt > MAX_HOLD_MS) {
    stop()
    return
  }
  // The call itself is the point: touching an extension API resets the timer.
  chrome.runtime.getPlatformInfo().catch(() => {})
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  holders = 0
}

/** Marks the start of work that must survive a closed panel. */
export function retain(): void {
  holders += 1
  if (timer === null) {
    startedAt = Date.now()
    timer = setInterval(tick, KEEPALIVE_INTERVAL_MS)
  }
}

/** Marks the end of that work; the worker may idle once all holders release. */
export function release(): void {
  holders = Math.max(0, holders - 1)
  if (holders === 0) stop()
}

/** Test/diagnostic accessor for the current hold count. */
export function activeHolds(): number {
  return holders
}
