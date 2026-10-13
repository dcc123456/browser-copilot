/**
 * Tests for the run-window lease (`background/window-policy.ts`).
 *
 * The contract under test is the one dcc ruled: overlapping unattended runs
 * never share a window. A run that finds the board free uses the shared plugin
 * window exactly as before; a run that finds it busy gets a window of its own
 * and closes it on settle. Past the cap, runs queue FIFO — and a queue they
 * cannot leave within the wait budget fails loudly, because a silently skipped
 * scheduled task is indistinguishable from one that never existed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getRun: vi.fn(),
  listRunning: vi.fn(),
  setRunWindow: vi.fn(),
  createRunWindow: vi.fn(),
  closeRunWindow: vi.fn(),
  currentPluginScope: vi.fn(),
  reclaimOrphanRunWindows: vi.fn(),
}))

vi.mock('../src/lib/storage', () => ({ getSettings: deps.getSettings, newId: () => 'id' }))
vi.mock('../src/background/running-tasks', () => ({
  getRun: deps.getRun,
  listRunning: deps.listRunning,
  setRunWindow: deps.setRunWindow,
}))
vi.mock('../src/background/automation-scope', () => ({
  closeRunWindow: deps.closeRunWindow,
  createRunWindow: deps.createRunWindow,
  currentPluginScope: deps.currentPluginScope,
  hasPanelWindows: () => true,
  isPluginWindow: () => true,
  latestPluginWindowId: () => 7,
  listNormalWindows: async () => [],
  normalScopeFromWindowId: async (windowId?: number) =>
    typeof windowId === 'number' ? { windowId } : undefined,
  reclaimOrphanRunWindows: deps.reclaimOrphanRunWindows,
}))

import {
  leaseRunWindow,
  releaseRunWindow,
  resolveUnattendedScope,
  runWindowFailureText,
  runWindowSlotState,
  RUN_WINDOW_MAX_WAIT_MS,
  RunWindowUnavailableError,
  _resetWindowPolicyForTests,
} from '../src/background/window-policy'

/** A board row: only the window matters for the collision test. */
function row(runId: string, windowId?: number): { runId: string; windowId?: number } {
  return { runId, ...(typeof windowId === 'number' ? { windowId } : {}) }
}

/** Let the lease's awaits run until `count` queued, then report the slot state. */
async function waitersQueued(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(runWindowSlotState()).toEqual({ occupied: [0], queued: count })
  })
}

let nextWindowId = 100

beforeEach(() => {
  vi.clearAllMocks()
  _resetWindowPolicyForTests()
  nextWindowId = 100
  deps.getSettings.mockResolvedValue({
    maxConcurrentRunWindows: 3,
    unattendedWindowPolicy: 'latest',
  })
  deps.getRun.mockReturnValue(undefined)
  deps.listRunning.mockReturnValue([])
  deps.currentPluginScope.mockResolvedValue({ windowId: 7 })
  deps.reclaimOrphanRunWindows.mockResolvedValue([])
  deps.createRunWindow.mockImplementation(async () => nextWindowId++)
  deps.closeRunWindow.mockResolvedValue(undefined)
})

afterEach(() => {
  _resetWindowPolicyForTests()
  vi.useRealTimers()
})

describe('leaseRunWindow', () => {
  it('uses the shared plugin window while the board is free', async () => {
    const lease = await leaseRunWindow('run-a')
    expect(lease).toEqual({ windowId: 7, dedicated: false })
    expect(deps.createRunWindow).not.toHaveBeenCalled()
    expect(deps.setRunWindow).toHaveBeenCalledWith('run-a', 7, 'shared')
  })

  it('takes a window of its own once another run is on the board', async () => {
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b')])
    const lease = await leaseRunWindow('run-b')
    expect(lease).toEqual({ windowId: 100, dedicated: true, tier: 0 })
    expect(deps.createRunWindow).toHaveBeenCalledWith('run-b', 0)
    expect(deps.setRunWindow).toHaveBeenCalledWith('run-b', 100, 'dedicated')
  })

  it('sends BOTH runs firing in the same instant into a window of their own', async () => {
    // Neither run has recorded a window yet when both look at the board.
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b')])
    const [first, second] = await Promise.all([leaseRunWindow('run-a'), leaseRunWindow('run-b')])
    expect(first.windowId).not.toBe(second.windowId)
    expect(first.dedicated && second.dedicated).toBe(true)
    expect(runWindowSlotState()).toEqual({ occupied: [0, 1], queued: 0 })
  })

  it('treats a windowless board row as about to use the shared window', async () => {
    // A chat turn records no window: it may act in the shared window any moment.
    deps.listRunning.mockReturnValue([row('chat-1')])
    const lease = await leaseRunWindow('run-a')
    expect(lease.dedicated).toBe(true)
  })

  it('stays shared when the other run works in a different window', async () => {
    deps.listRunning.mockReturnValue([row('run-b', 50)])
    const lease = await leaseRunWindow('run-a')
    expect(lease).toEqual({ windowId: 7, dedicated: false })
    expect(deps.createRunWindow).not.toHaveBeenCalled()
  })

  it('still isolates when no plugin window exists anywhere', async () => {
    deps.currentPluginScope.mockResolvedValue(undefined)
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b')])
    const lease = await leaseRunWindow('run-b')
    expect(lease).toEqual({ windowId: 100, dedicated: true, tier: 0 })
  })

  it('falls back to the shared window when Chrome refuses to create one', async () => {
    deps.createRunWindow.mockResolvedValue(undefined)
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b')])
    const lease = await leaseRunWindow('run-b')
    expect(lease).toEqual({ windowId: 7, dedicated: false })
    // The slot it reserved is handed back, so a later run is not blocked by it.
    expect(runWindowSlotState()).toEqual({ occupied: [], queued: 0 })
  })

  it('queues past the cap and hands the freed slot to the waiter', async () => {
    deps.getSettings.mockResolvedValue({ maxConcurrentRunWindows: 1 })
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b'), row('run-c')])

    const first = await leaseRunWindow('run-b')
    let waited = false
    const pending = leaseRunWindow('run-c', undefined, () => {
      waited = true
    })
    await waitersQueued(1)
    expect(waited).toBe(true)

    await releaseRunWindow(first)
    expect(deps.closeRunWindow).toHaveBeenCalledWith(first.windowId)
    const second = await pending
    expect(second).toEqual({ windowId: 101, dedicated: true, tier: 0 })
  })

  it('does nothing when releasing a shared lease', async () => {
    await releaseRunWindow({ windowId: 7, dedicated: false })
    expect(deps.closeRunWindow).not.toHaveBeenCalled()
    expect(runWindowSlotState()).toEqual({ occupied: [], queued: 0 })
  })

  it('drops a queued run when its abort signal fires', async () => {
    deps.getSettings.mockResolvedValue({ maxConcurrentRunWindows: 1 })
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b'), row('run-c')])
    const first = await leaseRunWindow('run-b')

    const controller = new AbortController()
    const pending = leaseRunWindow('run-c', controller.signal)
    await waitersQueued(1)
    controller.abort()
    const error = await pending.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RunWindowUnavailableError)
    expect((error as RunWindowUnavailableError).reason).toBe('cancelled')
    expect(runWindowSlotState()).toEqual({ occupied: [0], queued: 0 })
    // The terminated run still gets its window closed.
    await releaseRunWindow(first)
    expect(deps.closeRunWindow).toHaveBeenCalledWith(first.windowId)
  })

  it('fails the wait past the budget instead of skipping the run', async () => {
    deps.getSettings.mockResolvedValue({ maxConcurrentRunWindows: 1 })
    deps.listRunning.mockReturnValue([row('run-a'), row('run-b'), row('run-c')])
    await leaseRunWindow('run-b')

    // Arm the real timer but keep a handle on its callback, so the nine-minute
    // budget can expire on demand without fake timers (which would also freeze
    // `vi.waitFor` below).
    const realSetTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === RUN_WINDOW_MAX_WAIT_MS) expire = callback
      return realSetTimeout(callback, ms, ...args)
    }) as unknown as typeof setTimeout)

    const pending = leaseRunWindow('run-c')
    await waitersQueued(1)
    expire?.()
    const error = await pending.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RunWindowUnavailableError)
    expect((error as RunWindowUnavailableError).reason).toBe('capped')
    expect((error as RunWindowUnavailableError).max).toBe(1)
    expect(runWindowSlotState()).toEqual({ occupied: [0], queued: 0 })
    spy.mockRestore()
  })

  it('reports a failed lease in the user language', () => {
    expect(runWindowFailureText(new RunWindowUnavailableError('capped', 2), 'en')).toContain('2')
    expect(
      runWindowFailureText(new RunWindowUnavailableError('cancelled', 2), 'zh-CN'),
    ).toBeTruthy()
  })
})

describe('plain scope resolution', () => {
  it('ignores the running board — only the lease consults it', async () => {
    // Drift guard: user-gesture paths (panel Run button, shortcuts, the local
    // agent bridge) resolve through this function and must keep their window
    // whatever the board is doing, or a scheduled run would move the user's own
    // turn into a background window.
    deps.listRunning.mockReturnValue([row('run-a'), row('chat-1')])
    expect(await resolveUnattendedScope()).toEqual({ windowId: 7 })
    expect(deps.createRunWindow).not.toHaveBeenCalled()
  })
})
