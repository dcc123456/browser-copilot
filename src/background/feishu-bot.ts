/**
 * Receives commands from a Feishu self-built bot over the long-connection
 * (WebSocket) mode, letting a user trigger tasks by chatting to the bot.
 *
 * ## Protocol, correctly implemented
 *
 * Feishu's long connection is not a plain WebSocket. A working connection
 * requires:
 *  1. POST `/callback/ws/endpoint` (with a tenant token) to receive a time-limited
 *     WebSocket URL and a ClientId.
 *  2. Open that URL, then send a handshake frame carrying AppId/ClientId/Token.
 *  3. Reply to every server `ping` (type 9) with a `pong` (type 10) echoing the
 *     sequence id, within the server's heartbeat window.
 *  4. Decode `v2:event` request frames (type 1) whose payload is a protobuf
 *     wrapper; the event JSON lives in a string field.
 *
 * An earlier version of this file skipped steps 1–3 and opened a hard-coded URL,
 * which connected but never received messages. All of that now lives in
 * `lib/feishu-proto.ts`, which is unit-tested without a browser.
 *
 * ## Reconnection
 *
 * Reconnecting is a state machine, not a single `setTimeout`:
 * - On unexpected close, back off exponentially from 2 s to 30 s.
 * - A successful handshake resets the backoff.
 * - A watchdog `chrome.alarms` fires every minute while the bot is enabled; if
 *   the socket is not connected, it calls `ensureConnected()`. This is what
 *   recovers the connection after the MV3 service worker is evicted and later
 *   restarted by the alarm, which is the common failure path in an extension.
 * - While connected, a periodic extension-API call keeps the worker from idling
 *   out, so an idle bot does not get suspended 30 s after the last message.
 *
 * Even with all of this, an MV3 worker can be suspended while the browser is
 * fully idle, and Feishu cannot reach a suspended extension. The watchdog makes
 * recovery automatic and prompt once the browser does any work; it does not make
 * the bot reachable while the machine is asleep. That remains a hard platform
 * limit and is stated in the UI.
 *
 * @module background/feishu-bot
 */

import { getWsEndpoint, FeishuError, TenantTokenProvider, sendImText } from '../lib/feishu'
import {
  buildHandshakePayload,
  decodeFrame,
  encodePong,
  encodeRequest,
  interpretFrame,
  parseEvent,
} from '../lib/feishu-proto'
import { getFeishuConfig, listTasks } from '../lib/task-store'
import { triggerNow } from './scheduler'

const HANDSHAKE_METHOD = 'v2:handshake' as const

/** Alarm name the watchdog uses; also exported for clearing on stop. */
export const FEISHU_WATCHDOG_ALARM = 'feishu-bot-watchdog'
/** Watchdog period. `chrome.alarms` enforces a 1-minute minimum. */
const WATCHDOG_PERIOD_MINUTES = 1

/** Worker keepalive period, inside Chrome's ~30 s idle window. */
const WORKER_KEEPALIVE_MS = 20_000

/** Command prefixes the bot responds to, matched case-insensitively. */
export const COMMAND_PATTERNS = [
  /统计.*pr|review.*pr|pr.*review|待我审/i,
  /run task|执行任务|运行任务/i,
  /status|状态/i,
]

/** True when an inbound message text should trigger a task run. Exported for tests. */
export function isCommand(text: string): boolean {
  return COMMAND_PATTERNS.some((pattern) => pattern.test(text))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (ev: any) => void

interface SocketLike {
  readonly readyState: number
  binaryType: string
  close(code?: number, reason?: string): void
  send(data: Uint8Array | string): void
  onopen: AnyHandler | null
  onmessage: AnyHandler | null
  onclose: AnyHandler | null
  onerror: AnyHandler | null
}
type SocketCtor = new (url: string) => SocketLike

function defaultCtor(url: string): WebSocket {
  return new WebSocket(url)
}

function arrayFromMessage(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return null
}

export class FeishuBot {
  private socket: SocketLike | null = null
  private tokens: TenantTokenProvider | null = null
  private appId = ''
  private connected = false
  private handshakeDone = false
  private reconnectDelay = 2_000
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  /** True only while a connect attempt is in flight, to prevent duplicates. */
  private connecting = false

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socketCtor: SocketCtor = defaultCtor as unknown as SocketCtor,
  ) {}

  /**
   * (Re)evaluates whether the bot should be connected given current config.
   * Call after settings change and on worker startup.
   */
  async reconcile(): Promise<void> {
    const config = await getFeishuConfig()
    const wanted =
      config.botEnabled && config.appId.length > 0 && config.appSecret.length > 0

    if (!wanted) {
      this.stop()
      return
    }

    this.stopped = false
    if (!this.tokens) {
      this.appId = config.appId
      this.tokens = new TenantTokenProvider(config.appId, config.appSecret, this.fetchImpl)
    }
    // Arm the watchdog first so even a failed connect is retried by it.
    await this.armWatchdog()
    void this.ensureConnected()
  }

  /** Stops the bot and removes its watchdog. */
  stop(): void {
    this.stopped = true
    this.clearReconnectTimer()
    this.stopWorkerKeepalive()
    if (this.socket) {
      try {
        this.socket.close(1000, 'stopped')
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.connected = false
    this.handshakeDone = false
    this.connecting = false
    this.tokens = null
    void chrome.alarms.clear(FEISHU_WATCHDOG_ALARM).catch(() => {})
  }

  /**
   * Establishes a connection unless one already exists or is in progress.
   *
   * Public because the watchdog and the alarm handler call it directly; it is
   * also safe to call repeatedly (from reconcile, from reconnect, from the
   * watchdog) because of the `connecting`/`connected` guards.
   */
  async ensureConnected(): Promise<void> {
    if (this.stopped) return
    if (this.connected || this.connecting) return
    this.connecting = true
    try {
      await this.connect()
    } catch (error) {
      // connect() sets its own reconnect schedule; just log so a misconfiguration
      // is visible in the service-worker console.
      console.warn('[Browser Copilot] Feishu connect failed', error)
      this.scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  private async connect(): Promise<void> {
    if (!this.tokens) throw new Error('No credentials; call reconcile() first.')
    // 1. Resolve a fresh endpoint. Feishu issues one-time tokens, so a stale URL
    //    from a previous connection must never be reused.
    const endpoint = await getWsEndpoint(this.tokens, this.fetchImpl)

    // 2. Open the socket. Wrap the event handlers so a synchronous throw during
    //    setup still schedules a reconnect rather than killing the worker.
    const socket = new this.socketCtor(endpoint.url)
    this.socket = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = (): void => {
      this.connected = true
      this.reconnectDelay = 2_000
      try {
        // 3. Handshake immediately on open.
        const payload = buildHandshakePayload({
          appId: this.appId,
          clientId: endpoint.clientId,
          token: endpoint.token,
        })
        this.seq += 1
        socket.send(encodeRequest(this.seq, HANDSHAKE_METHOD, payload))
      } catch (error) {
        console.warn('[Browser Copilot] Feishu handshake send failed', error)
        this.teardownAndReconnect()
      }
    }

    socket.onmessage = (event: { data: unknown }): void => {
      try {
        this.onMessage(event.data)
      } catch (error) {
        console.warn('[Browser Copilot] Feishu frame handling failed', error)
      }
    }

    socket.onerror = (): void => {
      // onclose follows with the reason; nothing to do here but ensure we don't
      // leave the connecting flag stuck if it never opens.
      this.connected = false
    }

    socket.onclose = (event: { code?: number; reason?: string }): void => {
      this.connected = false
      this.handshakeDone = false
      this.stopWorkerKeepalive()
      this.socket = null
      if (!this.stopped) {
        console.info('[Browser Copilot] Feishu socket closed', event?.code, event?.reason)
        this.scheduleReconnect()
      }
    }
  }

  private onMessage(data: unknown): void {
    const bytes = arrayFromMessage(data)
    if (!bytes) return
    const frame = decodeFrame(bytes)
    if (!frame) return

    const interpreted = interpretFrame(frame)
    switch (interpreted.kind) {
      case 'ping':
        // Must reply within the heartbeat window or Feishu drops the connection.
        this.send(encodePong(interpreted.seq))
        break
      case 'handshake-ok':
        this.handshakeDone = true
        this.reconnectDelay = 2_000
        this.startWorkerKeepalive()
        console.info('[Browser Copilot] Feishu long connection established')
        break
      case 'handshake-error':
        console.warn('[Browser Copilot] Feishu handshake rejected', interpreted.code, interpreted.message)
        // A bad handshake is likely bad credentials/config; reconnect with the
        // normal backoff rather than spinning tightly.
        this.teardownAndReconnect()
        break
      case 'event':
        void this.handleEvent(interpreted.data)
        break
      case 'other':
        break
    }
  }

  private send(bytes: Uint8Array): void {
    if (this.socket && this.connected) {
      try {
        this.socket.send(bytes)
      } catch (error) {
        console.warn('[Browser Copilot] Feishu send failed', error)
        this.teardownAndReconnect()
      }
    }
  }

  private teardownAndReconnect(): void {
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.connected = false
    this.handshakeDone = false
    this.stopWorkerKeepalive()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer !== null) return
    const delay = Math.min(30_000, this.reconnectDelay)
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnected()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // --- MV3 worker keepalive while connected ----------------------------------

  private startWorkerKeepalive(): void {
    if (this.keepaliveTimer !== null) return
    // A connected long socket does not, by itself, count as activity that keeps
    // Chrome from suspending the worker after ~30 s. Any extension API call
    // resets that timer; getPlatformInfo is a cheap no-op.
    this.keepaliveTimer = setInterval(() => {
      try {
        void chrome.runtime.getPlatformInfo()
      } catch {
        // The worker is being torn down; the watchdog will reconnect later.
      }
    }, WORKER_KEEPALIVE_MS)
  }

  private stopWorkerKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  // --- Watchdog: survives worker eviction ------------------------------------

  private async armWatchdog(): Promise<void> {
    // periodInMinutes is the reliable form. `when` would fire once and stop; a
    // repeating alarm restarts the worker if it was suspended, which is exactly
    // the recovery we need.
    await chrome.alarms.create(FEISHU_WATCHDOG_ALARM, {
      periodInMinutes: WATCHDOG_PERIOD_MINUTES,
    })
  }

  /**
   * Called from `chrome.alarms.onAlarm`. A no-op when the bot is stopped; the
   * alarm itself is cleared in `stop()`.
   */
  onWatchdog(): void {
    if (this.stopped) return
    void this.ensureConnected()
  }

  /** Exposed for diagnostics/tests. */
  isConnected(): boolean {
    return this.connected && this.handshakeDone
  }

  // --- Inbound events --------------------------------------------------------

  private async handleEvent(data: string): Promise<void> {
    const message = parseEvent(data)
    if (!message) return
    if (!isCommand(message.text)) return

    const tasks = await listTasks()
    const reviewTask = tasks.find((task) => task.kind === 'github-review-requests')
    const named =
      tasks.find((task) => task.name && message.text.toLowerCase().includes(task.name.toLowerCase())) ??
      reviewTask

    if (!this.tokens) return
    const token = await this.tokens.get().catch(() => null)
    if (!token) return

    if (!named) {
      await safeReply(token, message.chatId, this.noTaskReply(message.text))
      return
    }

    await safeReply(token, message.chatId, this.ackReply(named.name, message.text))
    try {
      const outcome = await triggerNow(named.id, 'feishu')
      await sendImText(token, message.chatId, outcome.summary || '(no output)')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await safeReply(token, message.chatId, `Task failed: ${detail}`)
    }
  }

  private ackReply(name: string, text: string): string {
    const zh = /[\u4e00-\u9fff]/.test(text)
    return zh ? `收到，正在执行「${name}」…` : `Got it, running "${name}"…`
  }

  private noTaskReply(text: string): string {
    const zh = /[\u4e00-\u9fff]/.test(text)
    return zh
      ? '没有匹配的任务。在扩展的「任务」里创建一个，并在消息里提到它的名称。'
      : 'No matching task. Create one in the extension’s Tasks tab and mention its name.'
  }
}

async function safeReply(token: string, chatId: string, text: string): Promise<void> {
  try {
    await sendImText(token, chatId, text)
  } catch (error) {
    if (error instanceof FeishuError) console.warn('[Browser Copilot] feishu reply failed', error.code)
  }
}
