/**
 * Per-key write locks for read-modify-write persistence.
 *
 * Every collection in the store is a single JSON value mutated by
 * read-the-list → edit → write-the-list. Two concurrent mutations of the same
 * key therefore race: both read the same base list and the later write
 * silently drops the other's entry (reproduced with a latency-simulating
 * storage double: two concurrent `recordFinishedRun` calls left only one of
 * the two records). `chrome.storage` offers no compare-and-swap, so mutations
 * are queued behind one another per key instead.
 *
 * The queue lives in a module-level `Map`, so it serializes writers within one
 * JavaScript context. That is sufficient by design: content keys are written
 * only by the service worker (panel UIs go through commands — see
 * `sidepanel/HistoryTab.tsx` for the fixed offender), so one context holds
 * every mutation of a given key. Config keys (`settings`) are also mutated
 * from the SW only.
 *
 * @module lib/key-lock
 */

/** One queue per storage key; the tail promise serializes mutations. */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Runs `run` serialized against every other `withKeyLock(key, …)` call, in
 * issue order. A failed mutation neither blocks later ones nor poisons the
 * queue — its rejection propagates to its own caller only.
 */
export function withKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const tail = writeQueues.get(key) ?? Promise.resolve()
  const next = tail.then(run, run)
  // Swallow the settled result so one failed mutation cannot strand the queue.
  writeQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}
