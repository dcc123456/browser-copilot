/**
 * Outbound WebSocket client to the local agent adapter.
 *
 * The MV3 service worker connects OUT as a WebSocket *client* to a local
 * adapter on this machine (`ws://127.0.0.1:8765`, see
 * {@link normalizeLocalAgentUrl}). The adapter sends JSON requests over the
 * socket and this module replies (see {@link processAgentRequest} in
 * `agent-api.ts` for the protocol).
 *
 * ## Lifecycle
 *
 * The worker is disposable and can be evicted at any moment, so all state here
 * is module-scope and rebuilt from settings on every wake (`sync()`). A socket
 * that dies (or fails to open) is retried with exponential backoff, and a
 * periodic ping both detects dead connections and keeps the worker alive.
 *
 * No `chrome.*` API is touched at import time, so the module stays importable
 * in Node-based unit tests (which mock `WebSocket` globally).
 *
 * @module background/agent-client
 */

import { getSettings, setSettings } from '../lib/storage'
import type { AgentStatus, Settings } from '../lib/types'
import { DEFAULT_LOCAL_AGENT_URL, normalizeLocalAgentUrl } from '../lib/types'
import { processAgentRequest, type ExternalAgentResponse } from './agent-api'

/** First reconnect delay (ms); doubles on every failure until {@link RECONNECT_CAP_MS}. */
const RECONNECT_BASE_MS = 1_000
/** Longest delay between reconnect attempts (ms). */
const RECONNECT_CAP_MS = 30_000
/** How often a connected socket sends `{ type: 'ping' }` (ms). */
const HEARTBEAT_INTERVAL_MS = 25_000

// --- Module-scope mutable state (resets on worker eviction; that is fine) ----

let socket: WebSocket | null = null
/** The URL we are currently connecting to / connected to ('' when stopped). */
let targetUrl = ''
/** Settings used to open the current connection; reused for auth on replies. */
let lastSettings: Settings | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
/** Current backoff delay; reset to the base on a successful connection. */
let backoffMs = RECONNECT_BASE_MS

let status: AgentStatus = {
  enabled: false,
  url: DEFAULT_LOCAL_AGENT_URL,
  state: 'disconnected',
  agents: [],
}
const statusListeners = new Set<(next: AgentStatus) => void>()

function setStatus(next: AgentStatus): void {
  // A caller that only updates e.g. `state` must not wipe the agent list.
  const agents = next.agents ?? status.agents
  // Broadcast only on an actual change to any published field.
  if (
    status.enabled === next.enabled &&
    status.url === next.url &&
    status.state === next.state &&
    status.error === next.error &&
    status.connectedAt === next.connectedAt &&
    status.agents === agents
  ) {
    return
  }
  status = { ...next, agents }
  for (const listener of [...statusListeners]) {
    try {
      listener(status)
    } catch {
      // A listener must never break the connection machinery.
    }
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/**
 * Detaches and closes the current socket and clears every timer without
 * scheduling a reconnect (used by `stop()` and when switching target URLs).
 */
function teardownSocket(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHeartbeat()
  if (socket !== null) {
    const ws = socket
    socket = null
    // Detach handlers before closing so the 'close' event cannot schedule a
    // reconnect for an intentional teardown.
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }
}

/** Schedules one reconnect attempt; a pending timer swallows duplicates. */
function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (lastSettings && targetUrl) start(lastSettings)
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, RECONNECT_CAP_MS)
}

/** Sends a JSON ping every {@link HEARTBEAT_INTERVAL_MS} while the socket is open. */
function startHeartbeat(ws: WebSocket): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'ping' }))
    } catch {
      /* the close handler will deal with a dead socket */
    }
  }, HEARTBEAT_INTERVAL_MS)
}

/**
 * Handles one inbound message from the adapter: parse JSON, run it through
 * {@link processAgentRequest}, and echo the reply back tagged with the
 * request's `id` (when present).
 *
 * `agents.update` is a one-way notification (no `id`): the adapter reports the
 * currently connected agent connections, which the panel uses for the
 * "serve which connection" selector. It is never routed through the request
 * processor and never gets a reply.
 */
async function handleMessage(ws: WebSocket, event: MessageEvent): Promise<void> {
  if (socket !== ws) return
  let message: unknown
  try {
    message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
  } catch {
    return // not JSON — ignore
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return

  const request = message as Record<string, unknown>
  if (request.type === 'agents.update') {
    await applyAgentList(request.agents)
    return
  }
  const id = typeof request.id === 'number' || typeof request.id === 'string' ? request.id : undefined

  let response: ExternalAgentResponse
  try {
    // Pass the currently attached agent ids so the processor can tell a live
    // pin (enforce it) from a stale one (serve everyone instead of dropping).
    response = await processAgentRequest(
      message,
      lastSettings ?? (await getSettings()),
      status.agents.map((agent) => agent.id),
    )
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const payload = id !== undefined ? { ...response, id } : response
  try {
    if (socket === ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
    }
  } catch {
    // send is silent on failure; a dead socket surfaces via 'close'.
  }
}

/**
 * Replaces the published agent-connection list with the adapter's report,
 * dropping malformed entries. Cleared (to []) whenever the socket drops.
 *
 * When the user's pinned connection (`settings.localAgentActiveAgent`) is no
 * longer in the reported list, the pin is stale — the selected agent dropped
 * — so it is reset to `''` (serve every connection) and persisted, keeping
 * the selector honest and preventing silent request drops.
 */
async function applyAgentList(value: unknown): Promise<void> {
  const agents = Array.isArray(value)
    ? value
        .filter(
          (entry): entry is { id: string; name?: string } =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as { id?: unknown }).id === 'string',
        )
        .map((entry) => ({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        }))
    : []
  const pinned = (await getSettings()).localAgentActiveAgent
  if (pinned && !agents.some((agent) => agent.id === pinned)) {
    console.warn(
      `[Browser Copilot] local agent "${pinned}" is no longer connected; clearing the pinned selection.`,
    )
    await setSettings({ localAgentActiveAgent: '' })
  }
  setStatus({ ...status, agents })
}

/** Opens (or reuses) a connection to the given settings' normalized URL. */
function start(settings: Settings): void {
  const url = normalizeLocalAgentUrl(settings.localAgentUrl)

  // Already connected (or connecting) to this URL? Refresh the auth settings
  // so a token edit applies to the next request without a reconnect.
  if (
    socket !== null &&
    targetUrl === url &&
    socket.readyState !== WebSocket.CLOSED &&
    socket.readyState !== WebSocket.CLOSING
  ) {
    lastSettings = settings
    return
  }

  teardownSocket()
  lastSettings = settings
  targetUrl = url
  // A new connection has no agent list yet; the adapter re-reports it on connect.
  setStatus({ enabled: true, url, state: 'connecting', agents: [] })

  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (error) {
    // Constructor threw (bad URL, no WebSocket support) — retry later.
    socket = null
    setStatus({
      enabled: true,
      url,
      state: 'disconnected',
      error: error instanceof Error ? error.message : String(error),
      agents: [],
    })
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    backoffMs = RECONNECT_BASE_MS
    setStatus({
      enabled: true,
      url,
      state: 'connected',
      error: undefined,
      connectedAt: Date.now(),
      agents: [],
    })
    startHeartbeat(ws)
    // 连接建立后立即发一个 ping：适配器收到任意 ping 就会把本插件登记为
    // “插件连接”（真实插件的心跳不带 id，新版适配器兼容这种格式）。否则要等
    // 首个心跳间隔（25s）才被登记，期间 tools/list 只返回静态兜底列表、
    // 工具调用会报“插件未连接”。
    try {
      ws.send(JSON.stringify({ type: 'ping' }))
    } catch {
      /* the close handler will deal with a dead socket */
    }
  }

  ws.onmessage = (event) => {
    void handleMessage(ws, event)
  }

  ws.onerror = (event) => {
    if (socket !== ws) return
    const message =
      (event as { message?: string }).message ??
      (event as { error?: Error }).error?.message ??
      'WebSocket error.'
    setStatus({ enabled: true, url, state: 'disconnected', error: message, agents: [] })
  }

  ws.onclose = (event) => {
    if (socket !== ws) return
    socket = null
    stopHeartbeat()
    const message = (event as { reason?: string }).reason || 'Connection closed.'
    setStatus({ enabled: true, url, state: 'disconnected', error: message, agents: [] })
    scheduleReconnect()
  }
}

/** Tears the connection down and resets the status to idle. */
function stop(): void {
  teardownSocket()
  targetUrl = ''
  lastSettings = null
  setStatus({ enabled: false, url: DEFAULT_LOCAL_AGENT_URL, state: 'disconnected', agents: [] })
}

/**
 * Reconciles the connection with stored settings: connect when the bridge is
 * enabled, disconnect otherwise. Called on every worker wake and after
 * `settings.set`.
 */
async function sync(): Promise<void> {
  const settings = await getSettings()
  if (settings.localAgentEnabled) start(settings)
  else stop()
}

/** Returns a snapshot of the current connection status. */
function getStatus(): AgentStatus {
  return { ...status }
}

/** Subscribes to status changes; returns an unsubscribe function. */
function subscribeStatus(listener: (next: AgentStatus) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Singleton manager for the outbound local-agent WebSocket. */
export const agentClient = {
  sync,
  start,
  stop,
  getStatus,
  subscribeStatus,
}
