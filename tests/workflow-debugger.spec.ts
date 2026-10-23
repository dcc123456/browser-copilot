import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDebugSession,
  type DebugHookInfo,
  type DebugSessionOptions,
} from '../src/background/workflow-debugger'

function info(nodeId: string, breakpoint: boolean, variables = { count: 1 }): DebugHookInfo {
  return {
    nodeId,
    blockId: 'get-text',
    variables,
    breakpoint,
    signal: new AbortController().signal,
  }
}

function setup(overrides: Partial<DebugSessionOptions> = {}): {
  controller: AbortController
  events: string[]
  session: ReturnType<typeof createDebugSession>
} {
  const controller = new AbortController()
  const events: string[] = []
  const session = createDebugSession({
    signal: controller.signal,
    onPause: (pause) => events.push(`pause:${pause.nodeId}`),
    onResume: (pause) => events.push(`resume:${pause.nodeId}`),
    onStop: (reason) => events.push(`stop:${reason}`),
    pauseTimeoutMs: 60_000,
    ...overrides,
  })
  return { controller, events, session }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('breakpoint stepping', () => {
  it('pauses only on a breakpoint and resumes', async () => {
    const { session, events } = setup()
    let settled = false
    const held = Promise.resolve(session.hook(info('a', true))).then(() => {
      settled = true
    })

    expect(events).toEqual(['pause:a'])
    expect(session.paused()?.nodeId).toBe('a')
    expect(settled).toBe(false)

    expect(session.control('resume')).toBe(true)
    await held
    expect(events).toEqual(['pause:a', 'resume:a'])
    expect(session.paused()).toBeNull()
    expect(settled).toBe(true)
  })

  it('does not pause without a breakpoint', async () => {
    const { session, events } = setup()
    await session.hook(info('a', false))
    expect(events).toEqual([])
    expect(session.paused()).toBeNull()
  })

  it('next forces a pause before the successor even without a breakpoint', async () => {
    const { session, events } = setup()
    const first = session.hook(info('a', true))
    expect(session.control('next')).toBe(true)
    await first
    expect(events).toEqual(['pause:a', 'resume:a'])

    let successorSettled = false
    const second = Promise.resolve(session.hook(info('b', false))).then(() => {
      successorSettled = true
    })
    expect(events).toEqual(['pause:a', 'resume:a', 'pause:b'])
    expect(successorSettled).toBe(false)
    session.control('resume')
    await second
  })

  it('resume does not force a pause on the following node', async () => {
    const { session, events } = setup()
    const first = session.hook(info('a', true))
    session.control('resume')
    await first
    await session.hook(info('b', false))
    expect(events).toEqual(['pause:a', 'resume:a'])
  })

  it('snapshots the variables at pause time', () => {
    const { session } = setup()
    const variables = { count: 1 }
    void session.hook(info('a', true, variables))
    variables.count = 2
    expect(session.paused()?.variables).toEqual({ count: 1 })
  })
})

describe('stopping', () => {
  it('stop releases the pause and reports the stop', async () => {
    const { session, events } = setup()
    const held = session.hook(info('a', true))
    expect(session.control('stop')).toBe(true)
    await held
    expect(events).toEqual(['pause:a', 'stop:stop'])
    expect(session.control('resume')).toBe(false)
  })

  it('cancels a pause that exceeds the deadline', async () => {
    vi.useFakeTimers()
    const { session, events } = setup({ pauseTimeoutMs: 1000 })
    const held = session.hook(info('a', true))
    await vi.advanceTimersByTimeAsync(1000)
    await held
    expect(events).toEqual(['pause:a', 'stop:timeout'])
    expect(session.paused()).toBeNull()
  })

  it('answers false when nothing is paused', () => {
    const { session } = setup()
    expect(session.control('resume')).toBe(false)
    expect(session.control('next')).toBe(false)
    expect(session.control('stop')).toBe(false)
  })
})

describe('lifecycle', () => {
  it('dispose settles a held pause without callbacks', async () => {
    const { session, events } = setup()
    const held = session.hook(info('a', true))
    session.dispose()
    await held
    expect(events).toEqual(['pause:a'])
    expect(session.paused()).toBeNull()
    expect(session.control('resume')).toBe(false)
  })

  it('an abort settles the pause like a cancelled run', async () => {
    const { controller, session, events } = setup()
    const held = session.hook(info('a', true))
    controller.abort()
    await held
    expect(events).toEqual(['pause:a'])
    expect(session.paused()).toBeNull()
  })

  it('never pauses after dispose', async () => {
    const { session, events } = setup()
    session.dispose()
    await session.hook(info('a', true))
    expect(events).toEqual([])
  })
})
