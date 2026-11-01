/**
 * Sleeps, rejecting with an AbortError when the signal fires mid-wait.
 *
 * Kept outside `llm.ts` so callers that only need a cancellable timer do not
 * pull in the HTTP transport (and do not trip its test mocks).
 *
 * @module lib/sleep
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
