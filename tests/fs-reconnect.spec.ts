// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoReconnectStorage, reconnectStorageFolder, STORAGE_RECONNECTED_EVENT } from '../src/lib/fs-reconnect'

/**
 * The fs-store surface this module consumes, mocked so each test decides
 * whether a folder is configured and whether a (re)connection attempt
 * succeeds — the real one needs Chrome's File System Access permission state.
 */
const state = vi.hoisted(() => ({
  configured: false,
  mode: 'browser' as 'browser' | 'file',
  ensureConnects: true,
  ensureCalls: 0,
}))

vi.mock('../src/lib/fs-store', () => ({
  isStorageDirectoryConfigured: vi.fn(async () => state.configured),
  getStorageMode: vi.fn(async () => state.mode),
  ensureFileAccess: vi.fn(async () => {
    state.ensureCalls += 1
    if (state.ensureConnects) state.mode = 'file'
    return state.mode
  }),
}))

/** Drains the attempt chain's awaits (IDB read → mode check → ensure). */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Records the reconnected events dispatched on `window` during a test. */
function trackReconnected(): { events: Event[]; stop: () => void } {
  const events: Event[] = []
  const listener = (event: Event): void => {
    events.push(event)
  }
  window.addEventListener(STORAGE_RECONNECTED_EVENT, listener)
  return { events, stop: () => window.removeEventListener(STORAGE_RECONNECTED_EVENT, listener) }
}

const gesture = (): void => {
  window.dispatchEvent(new Event('pointerdown'))
}

describe('fs-reconnect', () => {
  beforeEach(() => {
    state.configured = false
    state.mode = 'browser'
    state.ensureConnects = true
    state.ensureCalls = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reconnectStorageFolder reports browser mode when nothing is configured', async () => {
    expect(await reconnectStorageFolder()).toBe('browser')
    expect(state.ensureCalls).toBe(0)
  })

  it('leaves an already-connected folder alone (the normal restart path)', async () => {
    state.configured = true
    state.mode = 'file'
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      gesture()
      await flush()
      expect(state.ensureCalls).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      teardown()
      stop()
    }
  })

  it('does nothing when no folder was ever configured', async () => {
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      gesture()
      await flush()
      expect(state.ensureCalls).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      teardown()
      stop()
    }
  })

  it('reconnects on the first user interaction and fires the event once', async () => {
    state.configured = true
    // The immediate attempt runs without a gesture — Chrome rejects it, so
    // the folder stays unreachable until the user actually interacts.
    state.ensureConnects = false
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      expect(state.ensureCalls).toBe(1)
      expect(state.mode).toBe('browser')
      expect(events).toHaveLength(0)

      // First click/keypress anywhere in the panel provides the gesture.
      state.ensureConnects = true
      gesture()
      await flush()
      expect(state.mode).toBe('file')
      expect(state.ensureCalls).toBe(2)
      expect(events).toHaveLength(1)

      // Connected: the listeners disarmed themselves.
      gesture()
      await flush()
      expect(state.ensureCalls).toBe(2)
      expect(events).toHaveLength(1)
    } finally {
      teardown()
      stop()
    }
  })

  it('teardown removes the gesture listeners', async () => {
    state.configured = true
    state.ensureConnects = false
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    await flush()
    expect(state.ensureCalls).toBe(1)
    teardown()
    gesture()
    await flush()
    expect(state.ensureCalls).toBe(1)
    expect(events).toHaveLength(0)
    stop()
  })
})
