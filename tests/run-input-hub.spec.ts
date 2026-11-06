/**
 * The background request/answer hub behind the runtime parameter dialog:
 * broadcast, timeout, cancellation and the keepalive hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunInputHub } from '../src/background/run-input-hub'

function makeHub(): {
  hub: ReturnType<typeof createRunInputHub>
  broadcast: ReturnType<typeof vi.fn>
  retain: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const broadcast = vi.fn((_message: unknown) => Promise.resolve())
  const retain = vi.fn()
  const release = vi.fn()
  const hub = createRunInputHub({
    broadcast: broadcast as unknown as (message: unknown) => Promise<void>,
    retain,
    release,
  })
  return { hub, broadcast, retain, release }
}

function input(timeoutMs = 1000): Parameters<ReturnType<typeof createRunInputHub>['request']>[0] {
  return {
    promptToken: 'prompt-page',
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowName: 'Demo',
    fields: [{ name: 'city', type: 'string', value: '', required: true }],
    timeoutMs,
  }
}

describe('createRunInputHub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('broadcasts the request, holds the worker and settles the answer', async () => {
    const { hub, broadcast, retain, release } = makeHub()
    const pending = hub.request(input(), new AbortController().signal)

    expect(retain).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    const message = broadcast.mock.calls[0]![0] as {
      type: string
      request: { requestId: string; promptToken: string }
    }
    expect(message.type).toBe('workflows.runInputRequest')
    expect(message.request.promptToken).toBe('prompt-page')

    expect(hub.answer(message.request.requestId, { values: { city: '上海' } })).toBe(true)
    await expect(pending).resolves.toEqual({ values: { city: '上海' } })
    expect(release).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'workflows.runInputSettled',
      requestId: message.request.requestId,
    })
    // Answering twice is a no-op: the run is already waiting on nothing.
    expect(hub.answer(message.request.requestId, { values: {} })).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('settles timedOut when nobody answers in time', async () => {
    const { hub, broadcast, release } = makeHub()
    const pending = hub.request(input(500), new AbortController().signal)
    const requestId = (broadcast.mock.calls[0]![0] as { request: { requestId: string } }).request
      .requestId

    await vi.advanceTimersByTimeAsync(499)
    expect(release).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ values: {}, timedOut: true })
    expect(release).toHaveBeenCalledTimes(1)
    expect(hub.answer(requestId, { values: { city: 'late' } })).toBe(false)
  })

  it('settles cancelled when the run is aborted while waiting', async () => {
    const { hub, release } = makeHub()
    const controller = new AbortController()
    const pending = hub.request(input(60_000), controller.signal)

    controller.abort()
    await expect(pending).resolves.toEqual({ values: {}, cancelled: true })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not ask at all for an already-cancelled run', async () => {
    const { hub, broadcast, retain, release } = makeHub()
    const controller = new AbortController()
    controller.abort()

    await expect(hub.request(input(), controller.signal)).resolves.toEqual({
      values: {},
      cancelled: true,
    })
    expect(broadcast).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('does not release twice when the run is aborted after the answer', async () => {
    const { hub, broadcast, release } = makeHub()
    const controller = new AbortController()
    const pending = hub.request(input(), controller.signal)
    const requestId = (broadcast.mock.calls[0]![0] as { request: { requestId: string } }).request
      .requestId

    hub.answer(requestId, { values: { city: 'ok' } })
    await pending
    controller.abort()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
