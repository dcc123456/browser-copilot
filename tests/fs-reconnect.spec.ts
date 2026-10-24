// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  autoReconnectStorage,
  reconnectStorageFolder,
  STORAGE_RECONNECTED_EVENT,
} from '../src/lib/fs-reconnect'

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
  resets: 0,
}))

vi.mock('../src/lib/fs-store', () => ({
  isStorageDirectoryConfigured: vi.fn(async () => state.configured),
  getStorageMode: vi.fn(async () => state.mode),
  ensureFileAccess: vi.fn(async () => {
    state.ensureCalls += 1
    if (state.ensureConnects) state.mode = 'file'
    return state.mode
  }),
  resetStorageCache: vi.fn(() => {
    state.resets += 1
  }),
  STORAGE_DIRECTORY_CHANGED: 'storage.directoryChanged',
  STORAGE_DISCONNECTED_EVENT: 'bc:storage-disconnected',
  STORAGE_DISCONNECTED_MESSAGE: 'storage.disconnected',
}))

const runtimeListeners = new Set<(message: unknown) => void>()

/** Drains the attempt chain's awaits (IDB read → mode check → ensure). */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
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

/** Records the storage-disconnected events dispatched on `window`. */
function trackDisconnected(): { events: Event[]; stop: () => void } {
  const events: Event[] = []
  const listener = (event: Event): void => {
    events.push(event)
  }
  window.addEventListener('bc:storage-disconnected', listener)
  return { events, stop: () => window.removeEventListener('bc:storage-disconnected', listener) }
}

const gesture = (): void => {
  window.dispatchEvent(new Event('pointerdown'))
}

const runtimeMessage = (type: string): void => {
  for (const listener of runtimeListeners) listener({ type })
}

describe('fs-reconnect', () => {
  beforeEach(() => {
    state.configured = false
    state.mode = 'browser'
    state.ensureConnects = true
    state.ensureCalls = 0
    state.resets = 0
    runtimeListeners.clear()
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown) => void) => runtimeListeners.add(listener),
          removeListener: (listener: (message: unknown) => void) =>
            runtimeListeners.delete(listener),
        },
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
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

      // Connected: an immediate second click re-checks at most (throttled) and
      // never asks for permission again.
      gesture()
      await flush()
      expect(state.ensureCalls).toBe(2)
      expect(events).toHaveLength(1)
    } finally {
      teardown()
      stop()
    }
  })

  it('reconnects again when the folder drops later in the same session', async () => {
    state.configured = true
    state.mode = 'file'
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      expect(events).toHaveLength(0)

      // Chrome tied the grant to the document and it lapsed: writes park, the
      // page stays open. The old hook had disarmed here for good.
      state.mode = 'browser'
      state.ensureConnects = false
      window.dispatchEvent(new Event('focus'))
      await flush()
      expect(state.ensureCalls).toBe(1)
      expect(events).toHaveLength(0)

      // The disconnect report/observation keeps the gesture retry armed.
      state.ensureConnects = true
      gesture()
      await flush()
      expect(state.ensureCalls).toBe(2)
      expect(state.mode).toBe('file')
      expect(events).toHaveLength(1)
    } finally {
      teardown()
      stop()
    }
  })

  it('a parked write re-arms the retry and refreshes the storage row', async () => {
    state.configured = true
    state.mode = 'file'
    const reconnected = trackReconnected()
    const disconnected = trackDisconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()

      // Another context wrote while the folder was unreachable and reported it.
      state.mode = 'browser'
      state.ensureConnects = false
      runtimeMessage('storage.disconnected')
      await flush()
      expect(disconnected.events).toHaveLength(1)
      expect(state.ensureCalls).toBe(1)

      state.ensureConnects = true
      gesture()
      await flush()
      expect(reconnected.events).toHaveLength(1)
      expect(state.mode).toBe('file')
    } finally {
      teardown()
      reconnected.stop()
      disconnected.stop()
    }
  })

  it('drops the local handle cache when another panel changes the folder', async () => {
    state.configured = true
    state.mode = 'file'
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      runtimeMessage('storage.directoryChanged')
      await flush()
      // The cached handle pointed at the old folder; it must be re-resolved.
      expect(state.resets).toBe(1)
      expect(events).toHaveLength(1)
    } finally {
      teardown()
      stop()
    }
  })

  it('retries when the panel becomes visible again, and skips hidden changes', async () => {
    state.configured = true
    state.ensureConnects = false
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      expect(state.ensureCalls).toBe(1)

      // A change to hidden is not an opportunity to retry.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(state.ensureCalls).toBe(1)

      // Visible again: the user is looking at the panel, so retry.
      Reflect.deleteProperty(document, 'visibilityState')
      state.ensureConnects = true
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(state.ensureCalls).toBe(2)
      expect(state.mode).toBe('file')
      expect(events).toHaveLength(1)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
      teardown()
      stop()
    }
  })

  it('retries when the window regains focus', async () => {
    state.configured = true
    state.ensureConnects = false
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    try {
      await flush()
      expect(state.ensureCalls).toBe(1)

      state.ensureConnects = true
      window.dispatchEvent(new Event('focus'))
      await flush()
      expect(state.ensureCalls).toBe(2)
      expect(state.mode).toBe('file')
      expect(events).toHaveLength(1)
    } finally {
      teardown()
      stop()
    }
  })

  it('teardown removes all reconnect listeners', async () => {
    state.configured = true
    state.ensureConnects = false
    const { events, stop } = trackReconnected()
    const teardown = autoReconnectStorage()
    await flush()
    expect(state.ensureCalls).toBe(1)
    expect(runtimeListeners.size).toBe(1)
    teardown()
    expect(runtimeListeners.size).toBe(0)
    gesture()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(state.ensureCalls).toBe(1)
    expect(events).toHaveLength(0)
    stop()
  })
})
