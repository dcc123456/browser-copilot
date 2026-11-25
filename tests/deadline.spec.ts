/**
 * `withDeadline` turns a hung platform call into a settleable wait: the budget
 * and the cancel signal both end the await, and a late settlement of the
 * abandoned work must not change the outcome or surface as unhandled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeadlineExceededError, withDeadline } from '../src/lib/deadline'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('withDeadline', () => {
  it('passes the settled value through', async () => {
    await expect(withDeadline(Promise.resolve('ok'))).resolves.toBe('ok')
    await expect(withDeadline('sync')).resolves.toBe('sync')
  })

  it('propagates the work’s own rejection', async () => {
    const failure = new Error('disk on fire')
    await expect(withDeadline(Promise.reject(failure), { ms: 1_000 })).rejects.toBe(failure)
  })

  it('rejects with a labelled deadline error once the budget is spent', async () => {
    vi.useFakeTimers()
    const work = deferred<string>()
    const pending = withDeadline(work.promise, { ms: 1_000, label: 'load conversation' })
    const outcome = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError)
    await vi.advanceTimersByTimeAsync(1_000)
    await outcome
    await expect(pending).rejects.toMatchObject({
      name: 'DeadlineExceededError',
      label: 'load conversation',
      ms: 1_000,
    })
    // The abandoned work settling afterwards changes nothing.
    work.resolve('late')
    await expect(pending).rejects.toBeInstanceOf(DeadlineExceededError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with an AbortError when the signal fires and clears its timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const work = deferred<string>()
    const pending = withDeadline(work.promise, { ms: 60_000, signal: controller.signal })
    const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await outcome
    expect(vi.getTimerCount()).toBe(0)
    work.resolve('ignored')
  })

  it('rejects at once for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const work = deferred<string>()
    await expect(withDeadline(work.promise, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    work.resolve('ignored')
  })

  it('refuses a budget that is already spent without waiting for the work', async () => {
    const work = deferred<string>()
    await expect(withDeadline(work.promise, { ms: 0, label: 'save index' })).rejects.toMatchObject({
      name: 'DeadlineExceededError',
      label: 'save index',
    })
    work.resolve('ignored')
  })
})
