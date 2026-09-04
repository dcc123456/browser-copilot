/**
 * Long-lived CDP event monitor: subscribes a tab to the Runtime / Log /
 * Network debugger domains for the duration of a debugging session and rings
 * the events into service-worker memory.
 *
 * ## Why this exists
 *
 * chrome-devtools-mcp keeps Puppeteer's event listeners attached for the whole
 * session, so `list_console_messages` / `list_network_requests` are reads of a
 * buffer, not probes. The extension used to have no passive listening at all:
 * console errors needed a `run_javascript` round trip and network state was
 * invisible. This module copies that pattern on the `chrome.debugger` API.
 *
 * ## Ownership vs `withCdpSession`
 *
 * The monitor OWNS its attachment for its idle lifetime. The driver's short
 * CDP sessions tolerate "already attached" and — crucially — skip their idle
 * detach while a monitor holds the tab (`isMonitorHolding`). The monitor
 * detaches itself after `MONITOR_IDLE_MS` without access, so the "extension
 * is debugging this tab" infobar disappears on its own.
 *
 * @module background/cdp-monitor
 */

/** How long an untouched monitor stays attached before self-detaching. */
const MONITOR_IDLE_MS = 60_000

const MAX_CONSOLE_ENTRIES = 200
const MAX_REQUEST_ENTRIES = 50

export interface ConsoleEntry {
  level: 'error' | 'warning' | 'log'
  text: string
  at: number
}

export interface RequestEntry {
  url: string
  method: string
  /** HTTP status once the response arrived; undefined while in flight. */
  status?: number
  /** True when the request failed at the network layer. */
  failed: boolean
  at: number
}

interface TabMonitor {
  tabId: number
  console: ConsoleEntry[]
  requests: RequestEntry[]
  /** Read cursor for {@link drainConsoleEntries}. */
  consoleCursor: number
  inflight: number
  inflightChangedAt: number
  idleTimer: ReturnType<typeof setTimeout>
}

const monitors = new Map<number, TabMonitor>()

/** Whether this module currently holds a debugger attachment on the tab. */
export function isMonitorHolding(tabId: number): boolean {
  return monitors.has(tabId)
}

function touch(monitor: TabMonitor): void {
  clearTimeout(monitor.idleTimer)
  monitor.idleTimer = setTimeout(() => {
    void releaseMonitor(monitor.tabId)
  }, MONITOR_IDLE_MS)
}

async function releaseMonitor(tabId: number): Promise<void> {
  const monitor = monitors.get(tabId)
  if (!monitor) return
  monitors.delete(tabId)
  clearTimeout(monitor.idleTimer)
  await chrome.debugger.detach({ tabId }).catch(() => {
    /* already detached (user dismissed the infobar, tab closed, …) */
  })
}

/** Ring-buffer push that drops the oldest entry beyond the cap. */
function push<T>(list: T[], cap: number, entry: T): void {
  list.push(entry)
  if (list.length > cap) list.splice(0, list.length - cap)
}

async function send(tabId: number, method: string, params?: Record<string, unknown>): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, method, params)
}

/**
 * Attaches the monitor to a tab (idempotent). Returns undefined when the
 * debugger is unavailable — callers must treat monitoring as best-effort and
 * fall back to their probing strategies.
 */
export async function ensureTabMonitor(tabId: number): Promise<void> {
  if (!chrome?.debugger) return
  const existing = monitors.get(tabId)
  if (existing) {
    touch(existing)
    return
  }
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (!/already attached|already being debugged/i.test(msg)) return
  }
  try {
    await send(tabId, 'Runtime.enable')
    await send(tabId, 'Log.enable')
    await send(tabId, 'Network.enable')
  } catch {
    await releaseMonitor(tabId)
    return
  }
  const monitor: TabMonitor = {
    tabId,
    console: [],
    requests: [],
    consoleCursor: 0,
    inflight: 0,
    // In-flight tracking starts "busy" briefly: events for requests already
    // in flight when we attached are partially lost, and an instant
    // "network idle" verdict right after attach would be a false positive.
    inflightChangedAt: Date.now(),
    idleTimer: setTimeout(() => {}, 0),
  }
  monitors.set(tabId, monitor)
  touch(monitor)
}

// Event routing. Registered once for all monitors; guarded for unit tests that
// import driver modules without a chrome global.
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId
    if (typeof tabId !== 'number') return
    const monitor = monitors.get(tabId)
    if (!monitor) return
    const p = params as Record<string, unknown> | undefined

    if (method === 'Runtime.consoleAPICalled') {
      const type = String(p?.type ?? '')
      // Control types without message text would render as empty entries.
      if (type === 'clear' || type === 'profile' || type === 'profileEnd') return
      const level: ConsoleEntry['level'] =
        type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : 'log'
      const args = Array.isArray(p?.args) ? (p!.args as { value?: unknown; description?: string }[]) : []
      const text = args
        .map((arg) => arg.description ?? (arg.value === undefined ? '' : String(arg.value)))
        .join(' ')
        .slice(0, 300)
      push(monitor.console, MAX_CONSOLE_ENTRIES, { level, text, at: Date.now() })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = p?.entry as { level?: string; text?: string } | undefined
      const raw = entry?.level
      if (!raw) return
      push(monitor.console, MAX_CONSOLE_ENTRIES, {
        level: raw === 'error' ? 'error' : raw === 'warning' ? 'warning' : 'log',
        text: String(entry?.text ?? '').slice(0, 300),
        at: Date.now(),
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = p?.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
      const text = (details?.exception?.description ?? details?.text ?? 'Uncaught exception').slice(0, 300)
      push(monitor.console, MAX_CONSOLE_ENTRIES, { level: 'error', text, at: Date.now() })
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const request = p?.request as { url?: string; method?: string } | undefined
      const entry: RequestEntry = {
        url: String(request?.url ?? '').slice(0, 300),
        method: String(request?.method ?? 'GET'),
        failed: false,
        at: Date.now(),
      }
      push(monitor.requests, MAX_REQUEST_ENTRIES, entry)
      monitor.inflight += 1
      monitor.inflightChangedAt = Date.now()
      return
    }
    if (method === 'Network.responseReceived') {
      const response = p?.response as { status?: number; url?: string } | undefined
      const status = typeof response?.status === 'number' ? response.status : undefined
      // Match the most recent in-flight entry with the same URL.
      for (let i = monitor.requests.length - 1; i >= 0; i -= 1) {
        const req = monitor.requests[i]!
        if (req.status === undefined && response?.url && req.url === response.url.slice(0, 300)) {
          req.status = status
          break
        }
      }
      monitor.inflight = Math.max(0, monitor.inflight - 1)
      monitor.inflightChangedAt = Date.now()
      return
    }
    if (method === 'Network.loadingFinished') {
      monitor.inflight = Math.max(0, monitor.inflight - 1)
      monitor.inflightChangedAt = Date.now()
      return
    }
    if (method === 'Network.loadingFailed') {
      const entry = monitor.requests[monitor.requests.length - 1]
      if (entry && entry.status === undefined) entry.failed = true
      monitor.inflight = Math.max(0, monitor.inflight - 1)
      monitor.inflightChangedAt = Date.now()
    }
  })

  // Chrome fires onDetach when the attachment dies from outside (user closes
  // the infobar, tab navigates to chrome://, DevTools takes over). Clean up so
  // a later ensureTabMonitor can re-attach instead of seeing a phantom hold.
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId
    if (typeof tabId === 'number') {
      const monitor = monitors.get(tabId)
      if (monitor) {
        monitors.delete(tabId)
        clearTimeout(monitor.idleTimer)
      }
    }
  })
}

/**
 * Resolves once no network request has been in flight for `idleMs`. Returns
 * `undefined` when no monitor is attached (caller falls back to probing);
 * `true` when a full idle window was observed before the timeout; `false`
 * when the timeout hit while still busy.
 */
export async function waitForNetworkIdle(
  tabId: number,
  idleMs = 500,
  timeout = 3000,
): Promise<boolean | undefined> {
  const monitor = monitors.get(tabId)
  if (!monitor) return undefined
  const deadline = Date.now() + timeout
  for (;;) {
    const quietFor = Date.now() - monitor.inflightChangedAt
    if (monitor.inflight === 0 && quietFor >= idleMs) return true
    if (Date.now() >= deadline) return monitor.inflight === 0
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Returns error/warning console entries recorded since the previous call
 * (per tab), marking them consumed. Used to attach fresh errors to an action
 * observation without repeating old ones every round.
 */
export function drainConsoleEntries(tabId: number, cap = 5): ConsoleEntry[] {
  const monitor = monitors.get(tabId)
  if (!monitor) return []
  const fresh = monitor.console.slice(monitor.consoleCursor).filter((e) => e.level === 'error')
  monitor.consoleCursor = monitor.console.length
  return fresh.slice(-cap)
}

/** Recent network requests for the tab (newest last). */
export function getRecentRequests(tabId: number, cap = 30): RequestEntry[] {
  const monitor = monitors.get(tabId)
  if (!monitor) return []
  return monitor.requests.slice(-cap).map((r) => ({ ...r }))
}

/**
 * Recent console entries for the tab (newest last). `level: 'errors'`
 * (default) keeps only error/warning entries; 'all' returns everything
 * captured, including plain log/info/debug output.
 */
export function getConsoleEntries(
  tabId: number,
  level: 'errors' | 'all' = 'errors',
): ConsoleEntry[] {
  const monitor = monitors.get(tabId)
  if (!monitor) return []
  const list = level === 'all' ? monitor.console : monitor.console.filter((e) => e.level !== 'log')
  return list.map((e) => ({ ...e }))
}
