import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The keepalive module reads `chrome.runtime.getPlatformInfo`, so a minimal stub
 * must exist before it is imported.
 */
const getPlatformInfo = vi.fn(() => Promise.resolve({}))
;(globalThis as unknown as { chrome: unknown }).chrome = { runtime: { getPlatformInfo } }

const { retain, release, activeHolds } = await import('../src/background/keepalive')

describe('keepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getPlatformInfo.mockClear()
  })

  afterEach(() => {
    // Drain any hold this test left, so state cannot leak between cases.
    while (activeHolds() > 0) release()
    vi.useRealTimers()
  })

  it('starts idle', () => {
    expect(activeHolds()).toBe(0)
  })

  it('pings periodically while held', () => {
    retain()
    expect(getPlatformInfo).not.toHaveBeenCalled()

    vi.advanceTimersByTime(20_000)
    expect(getPlatformInfo).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(40_000)
    expect(getPlatformInfo).toHaveBeenCalledTimes(3)
  })

  it('stops pinging once released', () => {
    retain()
    vi.advanceTimersByTime(20_000)
    expect(getPlatformInfo).toHaveBeenCalledTimes(1)

    release()
    expect(activeHolds()).toBe(0)
    vi.advanceTimersByTime(100_000)
    // No further pings: the worker is allowed to idle again.
    expect(getPlatformInfo).toHaveBeenCalledTimes(1)
  })

  it('reference counts concurrent turns', () => {
    retain()
    retain()
    expect(activeHolds()).toBe(2)

    release()
    expect(activeHolds()).toBe(1)

    // Still pinging: one turn is outstanding.
    vi.advanceTimersByTime(20_000)
    expect(getPlatformInfo).toHaveBeenCalledTimes(1)

    release()
    expect(activeHolds()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(getPlatformInfo).toHaveBeenCalledTimes(1)
  })

  it('never drops below zero on an unbalanced release', () => {
    release()
    release()
    expect(activeHolds()).toBe(0)
  })

  it('gives up after the maximum hold, so a stuck turn cannot pin the worker', () => {
    retain()
    // Past the 10-minute cap; the next tick must shut the timer down.
    vi.advanceTimersByTime(11 * 60 * 1000)
    const callsAtCap = getPlatformInfo.mock.calls.length

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(getPlatformInfo.mock.calls.length).toBe(callsAtCap)
    expect(activeHolds()).toBe(0)
  })

  it('can be retained again after the cap released it', () => {
    retain()
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(activeHolds()).toBe(0)

    retain()
    const before = getPlatformInfo.mock.calls.length
    vi.advanceTimersByTime(20_000)
    expect(getPlatformInfo.mock.calls.length).toBe(before + 1)
  })

  it('survives a rejected ping', async () => {
    getPlatformInfo.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    retain()
    vi.advanceTimersByTime(40_000)
    // A failed ping must not tear down the interval.
    expect(getPlatformInfo).toHaveBeenCalledTimes(2)
    expect(activeHolds()).toBe(1)
  })
})
