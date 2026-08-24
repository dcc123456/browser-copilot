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
 * ## Routing inbound messages
 *
 * Not every message is a hard-coded command. When text arrives:
 *  1. If it names a saved task, run that task.
 *  2. If it matches a built-in shorthand (e.g. "review PRs") and such a task
 *     exists, run it.
 *  3. Otherwise run it as a one-off agent instruction in `full` autonomy, so the
 *     agent can open a tab and read the page without a human approving each
 *     step. This is what makes "帮我查看微博热搜" actually do something.
 *
 * @module background/feishu-bot
 */

import { getWsEndpoint, FeishuError, TenantTokenProvider, sendImText, httpFetch } from '../lib/feishu'
import {
  decodeFrame,
  encodeAck,
  encodePing,
  encodeFrame,
  header,
  parseEvent,
  METHOD,
  CTRL,
  DATA,
  type Frame,
} from '../lib/feishu-proto'
import { getFeishuConfig, listTasks } from '../lib/task-store'
import { triggerNow } from './scheduler'
import { runUnattendedPrompt } from './agent-unattended'
import {
  addStep,
  finishRun,
  listRunning,
  setOnCancel,
  startRun,
} from './running-tasks'


/** Alarm name the watchdog uses; also exported for clearing on stop. */
export const FEISHU_WATCHDOG_ALARM = 'feishu-bot-watchdog'
/** Watchdog period. `chrome.alarms` enforces a 1-minute minimum. */
const WATCHDOG_PERIOD_MINUTES = 1

/** Worker keepalive period, inside Chrome's ~30 s idle window. */
const WORKER_KEEPALIVE_MS = 20_000

/** How often batched agent steps are flushed to Feishu. */
const STEP_FLUSH_INTERVAL_MS = 3_000

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
  private appId = ''
  private appSecret = ''
  /**
   * Tenant token used only for the IM send API (replying to a message).
   * Endpoint discovery authenticates with the app id/secret in the body and does
   * not use this.
   */
  private tokenProvider: TenantTokenProvider | null = null
  /** `service_id` from the WSS URL; set on each connect and used in ping frames. */
  private serviceId = 0
  private connected = false
  private reconnectDelay = 2_000
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  /** True only while a connect attempt is in flight, to prevent duplicates. */
  private connecting = false
  /**
   * Recently handled event ids, retained for a short window so a redelivery of
   * the same event (server retries when it considers an ACK lost, or a worker
   * restart) does not run a task twice. Sized as a ring buffer; order tracks
   * arrival so the oldest can be evicted.
   */
  private recentEventIds: string[] = []
  private static readonly MAX_RECENT_EVENT_IDS = 64

  constructor(
    private readonly fetchImpl: typeof fetch = httpFetch,
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
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.tokenProvider = new TenantTokenProvider(config.appId, config.appSecret, this.fetchImpl)
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
    this.connecting = false
    this.tokenProvider = null
    this.stopPingLoop()
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
    if (!this.appId || !this.appSecret) {
      throw new Error('No credentials; call reconcile() first.')
    }
    // If a previous socket is still around (open or half-closed), close it
    // before opening a replacement so we never have two connections receiving
    // the same events in parallel.
    if (this.socket) {
      try {
        this.socket.close(1000, 'reconnecting')
      } catch {
        // ignore
      }
      this.socket = null
    }
    // 1. Resolve a fresh endpoint. The returned URL carries one-time
    //    access_key/ticket credentials, so a stale URL from a previous
    //    connection must never be reused.
    const endpoint = await getWsEndpoint(this.appId, this.appSecret, this.fetchImpl)
    this.serviceId = endpoint.serviceId
    console.info('[Browser Copilot] Feishu endpoint resolved; opening socket', endpoint.deviceId)

    // 2. Open the socket. Auth is entirely in the WSS URL — there is no
    //    in-band handshake frame to send on open. Wrap the event handlers so a
    //    synchronous throw during setup still schedules a reconnect rather than
    //    killing the worker.
    const socket = new this.socketCtor(endpoint.url)
    this.socket = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = (): void => {
      this.connected = true
      this.reconnectDelay = 2_000
      // The server sends a ping every PingInterval (~90 s) and drops the
      // connection if we don't pong; we also ping proactively so a dead NAT
      // path is detected before the watchdog runs.
      this.startPingLoop(endpoint.pingIntervalSeconds)
      this.startWorkerKeepalive()
      console.info('[Browser Copilot] Feishu long connection established')
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
      this.stopPingLoop()
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

    // method 0 = control (ping/pong); method 1 = data (events/cards).
    if (frame.method === METHOD.CONTROL) {
      const type = header(frame, 'type')
      if (type === CTRL.PING) {
        // Reply with a pong carrying the server's ping payload (it holds the
        // negotiated intervals). Must arrive within the heartbeat window.
        this.send(this.encodePongFor(frame))
      }
      // PONG is a response to our own ping; no action beyond resetting the
      // liveness timer (which any inbound frame already does implicitly).
      return
    }

    if (frame.method === METHOD.DATA) {
      const type = header(frame, 'type')
      if (type === DATA.EVENT) {
        // ACK first so Feishu does not retry delivery or drop us; the actual
        // work is fire-and-forget after the acknowledgement.
        this.send(encodeAck(frame))
        const payload = new TextDecoder().decode(frame.payload)
        void this.handleEvent(payload)
      } else {
        console.info('[Browser Copilot] Feishu unhandled data frame', type)
      }
    }
  }

  /** Encodes a pong control frame echoing an inbound ping. */
  private encodePongFor(inbound: Frame): Uint8Array {
    return encodeFrame({
      seqId: inbound.seqId,
      logId: inbound.logId,
      service: inbound.service,
      method: METHOD.CONTROL,
      headers: [{ key: 'type', value: CTRL.PONG }],
      payload: inbound.payload,
    })
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
    this.stopPingLoop()
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

  // --- Ping/pong liveness ----------------------------------------------------

  /**
   * Sends a ping control frame on the server-advertised interval (defaulting to
   * 90 s). The server replies with a pong; the traffic itself also keeps the
   * NAT/firewall path open. The loop is cleared on close/stop.
   */
  private startPingLoop(intervalSeconds: number): void {
    this.stopPingLoop()
    const intervalMs = Math.max(10_000, (intervalSeconds || 90) * 1000)
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null
      if (!this.connected || !this.socket) return
      this.send(encodePing(this.serviceId))
      this.startPingLoop(intervalSeconds)
    }, intervalMs)
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearTimeout(this.pingTimer)
      this.pingTimer = null
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
    return this.connected
  }

  // --- Inbound events --------------------------------------------------------

  private async handleEvent(data: string): Promise<void> {
    const message = parseEvent(data)
    if (!message) return
    const text = message.text
    // Ignore very short/empty messages and @-mention noise. Anything substantive
    // is either a named-task trigger or an ad-hoc instruction for the agent.
    if (text.length === 0) return

    // Drop duplicate deliveries. Feishu redelivers an event when it does not see
    // a successful ACK in time (or when the worker reconnects); without this
    // guard the same task can fire several times in a row. Keyed on event_id
    // (falling back to message_id), retained in a small ring buffer.
    const dedupeKey = message.eventId || message.messageId
    if (dedupeKey && this.recentEventIds.includes(dedupeKey)) {
      console.info('[Browser Copilot] Feishu ignored duplicate event', dedupeKey)
      return
    }
    if (dedupeKey) {
      this.recentEventIds.push(dedupeKey)
      if (this.recentEventIds.length > FeishuBot.MAX_RECENT_EVENT_IDS) {
        this.recentEventIds.shift()
      }
    }

    if (!this.tokenProvider) return
    const token = await this.tokenProvider.get().catch(() => null)
    if (!token) return

    // 1. Named task? If the message mentions a saved task name, run that task.
    const tasks = await listTasks()
    const named = tasks.find(
      (task) => task.name && text.toLowerCase().includes(task.name.toLowerCase()),
    )
    if (named) {
      await safeReply(token, message.chatId, this.ackReply(named.name, text))
      await this.runAndReport(token, message.chatId, named.id, named.name)
      return
    }

    // 2. Built-in shorthand: a PR review request without a named task.
    if (isCommand(text)) {
      const reviewTask = tasks.find((task) => task.kind === 'github-review-requests')
      if (reviewTask) {
        await safeReply(token, message.chatId, this.ackReply(reviewTask.name, text))
        await this.runAndReport(token, message.chatId, reviewTask.id, reviewTask.name)
        return
      }
    }

    // 3. Otherwise treat the message as a one-off instruction for the agent.
    //    This is what lets "帮我查看微博现在的热搜是什么" open a tab and answer.
    await safeReply(token, message.chatId, this.thinkingReply(text))
    const tracked = startRun({
      label: text.slice(0, 40),
      source: 'feishu',
      feishuChatId: message.chatId,
      onCancel: () => {
        void safeReply(token, message.chatId, '⏹ 任务已终止。')
      },
    })
    const streamer = new StepStreamer(token, message.chatId)
    streamer.start()
    let cancelled = false
    let failure: string | undefined
    try {
      const result = await runUnattendedPrompt(
        this.withBrowserGuidance(text),
        `feishu:${message.messageId || message.chatId}`,
        'full',
        {
          signal: tracked.controller.signal,
          onStep: (kind, stepText) => {
            addStep(tracked.runId, kind, stepText)
            streamer.push(stepText)
          },
        },
      )
      cancelled = !!result.cancelled
      failure = result.error
      streamer.flush()
      if (result.cancelled) {
        await safeReply(token, message.chatId, '⏹ 任务已终止。')
      } else {
        const reply = result.answer?.trim() || result.error || '(no answer)'
        await sendImText(token, message.chatId, reply)
      }
    } catch (error) {
      streamer.flush()
      failure = error instanceof Error ? error.message : String(error)
      await safeReply(token, message.chatId, `Failed: ${failure}`)
    } finally {
      streamer.stop()
      finishRun(tracked.runId, {
        outcome: cancelled ? 'cancelled' : failure ? 'failed' : 'ok',
        summary: failure,
      })
      // The run (with all its steps) is persisted by finishRun's registered
      // persister, so ad-hoc Feishu instructions survive a worker restart too.
    }
  }

  /**
   * Runs a saved task triggered from Feishu and reports its progress. Named
   * tasks register their own run in the running-tasks board; we poll that
   * board's steps and stream them to the chat, batching to avoid spamming, then
   * send the final summary. The `feishuChatId` on the run lets a manual
   * termination from the board also reach this chat (via the board watcher).
   */
  private async runAndReport(
    token: string,
    chatId: string,
    taskId: string,
    _name: string,
  ): Promise<void> {
    try {
      const runPromise = triggerNow(taskId, 'feishu', chatId)
      // Poll the running-tasks board for this task's steps while it runs.
      const streamer = new StepStreamer(token, chatId)
      streamer.start()
      let lastCount = 0
      const poll = setInterval(() => {
        const run = listRunning().find((r) => r.taskId === taskId)
        if (!run) return
        // Once the task registers itself, wire a cancellation notice so a
        // terminate click on the board tells this chat too.
        setOnCancel(run.runId, () => {
          void safeReply(token, chatId, '⏹ 任务已终止。')
        })
        for (let i = lastCount; i < run.steps.length; i += 1) {
          const step = run.steps[i]!
          streamer.push(step.text)
        }
        lastCount = run.steps.length
      }, 1_000)
      try {
        const outcome = await runPromise
        streamer.flush()
        clearInterval(poll)
        if (outcome.cancelled) {
          await safeReply(token, chatId, '⏹ 任务已终止。')
        } else {
          await sendImText(token, chatId, outcome.summary || '(no output)')
        }
      } catch (error) {
        clearInterval(poll)
        streamer.flush()
        const detail = error instanceof Error ? error.message : String(error)
        await safeReply(token, chatId, `Task failed: ${detail}`)
      } finally {
        streamer.stop()
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await safeReply(token, chatId, `Task failed: ${detail}`)
    }
  }

  /**
   * Adds a short instruction for browser-driven questions, so the agent knows it
   * can open a tab and read the page rather than answering from its training
   * data alone. Kept tiny: the user's own wording is what matters.
   */
  private withBrowserGuidance(text: string): string {
    return (
      `${text}\n\n` +
      'You are being driven from a chat. If answering requires current web ' +
      'content, open the relevant page in a tab, read it, and answer concisely ' +
      'in the same language as the request.'
    )
  }

  private ackReply(name: string, text: string): string {
    const zh = /[\u4e00-\u9fff]/.test(text)
    return zh ? `收到，正在执行「${name}」…` : `Got it, running "${name}"…`
  }

  private thinkingReply(text: string): string {
    const zh = /[\u4e00-\u9fff]/.test(text)
    return zh ? '收到，正在处理…' : 'Got it, working on it…'
  }
}

async function safeReply(token: string, chatId: string, text: string): Promise<void> {
  try {
    await sendImText(token, chatId, text)
  } catch (error) {
    if (error instanceof FeishuError) console.warn('[Browser Copilot] feishu reply failed', error.code)
  }
}

/**
 * Batches per-step progress into fewer Feishu messages.
 *
 * An agent turn can emit a tool.start/tool.result pair per action; sending each
 * as its own IM message floods the chat. This accumulates pushed lines and
 * flushes them on an interval (and on demand at the end), collapsing a burst of
 * steps into a single progress update.
 */
class StepStreamer {
  private buffer: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), STEP_FLUSH_INTERVAL_MS)
  }

  push(text: string): void {
    if (text) this.buffer.push(text)
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const text = this.buffer.join('\n')
    this.buffer = []
    void safeReply(this.token, this.chatId, text)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
