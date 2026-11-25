/**
 * Awaiting platform work under a wall-clock budget and/or a cancel signal.
 *
 * A chat turn's pre-flight only awaits local storage (transcript read, meta
 * write) and page reads. None of those calls can be cancelled, and a data
 * folder that stopped responding leaves them pending forever — the turn then
 * shows "preparing" with no way out and the Stop button reaches nothing.
 * Racing them here turns that stall into an ordinary failure the turn can
 * report, and lets a cancel settle a wait that has not reached the model yet.
 *
 * The underlying operation is NOT cancelled: it keeps running and its later
 * result is simply dropped.
 *
 * @module lib/deadline
 */

/** Raised when `work` did not settle inside its budget. */
export class DeadlineExceededError extends Error {
  /** Caller-supplied step name, for the log line and the user-facing detail. */
  readonly label: string
  readonly ms: number

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${Math.round(ms / 1000)}s.`)
    this.name = 'DeadlineExceededError'
    this.label = label
    this.ms = ms
  }
}

export interface DeadlineOptions {
  /** Budget in milliseconds. Omitted → no budget, wait as long as `work` does. */
  ms?: number
  /** Cancels the wait (rejects with an AbortError), leaving `work` running. */
  signal?: AbortSignal
  /** Names the step in {@link DeadlineExceededError}; defaults to `work`. */
  label?: string
}

/**
 * Resolves or rejects with `work`, unless `signal` aborts (AbortError) or the
 * budget runs out ({@link DeadlineExceededError}) first.
 */
export async function withDeadline<T>(
  work: T | PromiseLike<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  const { ms, signal, label = 'work' } = options
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const pending = Promise.resolve(work)
  if (ms === undefined && !signal) return pending
  if (ms !== undefined && ms <= 0) {
    // The budget was already spent before this step started: hand the caller a
    // deadline error now and keep the work's own rejection from going unhandled.
    void pending.catch(() => undefined)
    throw new DeadlineExceededError(label, ms)
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      settle(() => reject(new DOMException('Aborted', 'AbortError')))
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      finish()
    }
    if (ms !== undefined) {
      timer = setTimeout(() => settle(() => reject(new DeadlineExceededError(label, ms))), ms)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // An abort dispatched between the initial check and the listener landing
    // never reaches us; settle on it explicitly.
    if (signal?.aborted) onAbort()
    // The rejection handler stays attached after a timeout/cancel, so the late
    // settlement of the abandoned operation cannot surface as unhandled.
    pending.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    )
  })
}
