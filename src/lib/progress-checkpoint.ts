/**
 * Crash-resilient transcript writes for a running chat turn.
 *
 * A turn normally persists its transcript once, in the `finally` that runs
 * after the agent finishes. That is never reached when the service worker is
 * killed (OS OOM) or the extension is reloaded, so the turn's messages would
 * exist only in memory and the conversation would reopen stale or empty. This
 * helper offers periodic snapshots to `save` while the turn streams, bounded
 * so a long answer cannot turn into a write storm.
 *
 * Writes are serialized: two saves of the same storage key must never land out
 * of order. A pending snapshot is superseded by the next `schedule`, and
 * {@link ProgressCheckpoint.flush} is terminal, so the turn's own final save is
 * always the last write for that key.
 *
 * Chrome-free by design (AGENTS §5.7); the caller owns the actual persistence.
 *
 * @module lib/progress-checkpoint
 */
import type { WireMessage } from './llm'

/**
 * Minimum gap between two progress writes. A crash can therefore lose at most
 * this much of the in-flight turn, which is bounded while still keeping the
 * rewrite of a multi-megabyte transcript off the delta path.
 */
export const PROGRESS_CHECKPOINT_MS = 5_000

export interface ProgressCheckpoint {
  /**
   * Offer the live transcript. The array is referenced, not copied, so calls
   * stay cheap while the turn keeps appending; the snapshot written when the
   * timer fires is whatever the transcript holds at that point.
   */
  schedule(messages: readonly WireMessage[]): void
  /**
   * Cancel a pending snapshot and wait for a write already in flight. Terminal:
   * later `schedule` calls are ignored.
   */
  flush(): Promise<void>
}

export function createProgressCheckpoint(
  save: (messages: WireMessage[]) => Promise<void>,
  intervalMs: number = PROGRESS_CHECKPOINT_MS,
): ProgressCheckpoint {
  let latest: readonly WireMessage[] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastWriteAt = 0
  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const write = (): void => {
    timer = null
    const snapshot = latest === null ? null : [...latest]
    latest = null
    if (!snapshot || snapshot.length === 0) return
    lastWriteAt = Date.now()
    // A failed checkpoint must not fail the turn: the final save in the turn's
    // `finally` is what surfaces a real storage problem to the user.
    queue = queue.then(() => save(snapshot)).catch(() => undefined)
  }

  return {
    schedule(messages) {
      if (closed || messages.length === 0) return
      latest = messages
      if (timer !== null) return
      // First call writes immediately (the user's own message becomes durable
      // before the model is asked anything); later calls are throttled.
      const wait = Math.max(0, intervalMs - (Date.now() - lastWriteAt))
      timer = setTimeout(write, wait)
    },
    async flush() {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // The caller's final save is newer than anything still pending here.
      latest = null
      await queue
    },
  }
}
