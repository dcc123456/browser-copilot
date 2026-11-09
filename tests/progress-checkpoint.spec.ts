/**
 * Contract of the crash-resilient chat transcript checkpoint: throttled writes,
 * latest snapshot wins, serialized saves, and a terminal flush that guarantees
 * the turn's own final save is the last write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressCheckpoint, PROGRESS_CHECKPOINT_MS } from '../src/lib/progress-checkpoint'
import type { WireMessage } from '../src/lib/llm'

const user = (content: string): WireMessage => ({ role: 'user', content })

describe('createProgressCheckpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the first snapshot immediately, then throttles', async () => {
    const save = vi.fn(async () => undefined)
    const progress = createProgressCheckpoint(save)
    const history = [user('first')]

    progress.schedule(history)
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith([user('first')])

    history.push(user('second'))
    progress.schedule(history)
    await vi.advanceTimersByTimeAsync(PROGRESS_CHECKPOINT_MS - 1)
    expect(save).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(2)
    // The array is read when the timer fires, so the newest turn is included.
    expect(save).toHaveBeenLastCalledWith([user('first'), user('second')])
    await progress.flush()
  })

  it('serializes writes so a slow save cannot be overtaken', async () => {
    let releaseFirst: (() => void) | null = null
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const progress = createProgressCheckpoint(save)
    const history = [user('first')]

    progress.schedule(history)
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)

    history.push(user('second'))
    progress.schedule(history)
    await vi.advanceTimersByTimeAsync(PROGRESS_CHECKPOINT_MS)
    // The second write is queued behind the first, not dispatched beside it.
    expect(save).toHaveBeenCalledTimes(1)

    releaseFirst!()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    await progress.flush()
  })

  it('flush drops a pending snapshot and ignores later schedules', async () => {
    const save = vi.fn(async () => undefined)
    const progress = createProgressCheckpoint(save)
    const history = [user('first')]

    progress.schedule(history)
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)

    history.push(user('never written'))
    progress.schedule(history)
    await progress.flush()
    await vi.advanceTimersByTimeAsync(PROGRESS_CHECKPOINT_MS * 2)
    expect(save).toHaveBeenCalledTimes(1)

    progress.schedule([user('after flush')])
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('never writes an empty transcript', async () => {
    const save = vi.fn(async () => undefined)
    const progress = createProgressCheckpoint(save)

    progress.schedule([])
    await vi.advanceTimersByTimeAsync(PROGRESS_CHECKPOINT_MS)
    expect(save).not.toHaveBeenCalled()
    await progress.flush()
  })

  it('keeps checkpointing after a failed write', async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValue(undefined)
    const progress = createProgressCheckpoint(save)

    progress.schedule([user('first')])
    await vi.advanceTimersByTimeAsync(0)
    progress.schedule([user('second')])
    await vi.advanceTimersByTimeAsync(PROGRESS_CHECKPOINT_MS)

    expect(save).toHaveBeenCalledTimes(2)
    await progress.flush()
  })
})
