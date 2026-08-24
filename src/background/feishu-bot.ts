/**
 * Receives commands from a Feishu self-built bot over the long-connection mode,
 * letting a user trigger tasks by chatting to the bot.
 *
 * ## MV3 limitation, stated plainly
 *
 * A Manifest V3 service worker is suspended after ~30 s of inactivity. A WebSocket
 * does not, by itself, count as activity that keeps Chrome from suspending the
 * worker, and a suspended worker cannot read from the socket. This module does
 * everything it can within that constraint:
 *
 * - It connects only while `botEnabled` is set and credentials are present.
 * - It holds the worker keepalive reference while connected.
 * - On any disconnect it reconnects with backoff.
 *
 * But **it cannot guarantee delivery while the browser is idle for long periods**:
 * Chrome may still suspend the worker, and Feishu's long-connection mode is not a
 * perfect match for an event page. The reliable path for unattended triggers is
 * still `chrome.alarms`; Feishu commands are best-effort and work well while the
 * browser is active. If reliable always-on inbound commands matter, a small relay
 * (e.g. a Cloudflare worker that buffers commands) is the correct architecture
 * and is intentionally not built here.
 *
 * @module background/feishu-bot
 */

import { FeishuError, TenantTokenProvider, sendImText } from '../lib/feishu'
import { getFeishuConfig, listTasks } from '../lib/task-store'
import { triggerNow } from './scheduler'
import { retain, release } from './keepalive'

/** Feishu long-connection endpoint (WebSocket mode). */
const ENDPOINT = 'wss://msg-frontier.feishu.cn/ws/v2'

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
  close(): void
  onopen: AnyHandler | null
  onmessage: AnyHandler | null
  onclose: AnyHandler | null
  onerror: AnyHandler | null
}
type SocketCtor = new (url: string) => SocketLike

function defaultCtor(url: string): WebSocket {
  return new WebSocket(url)
}

export class FeishuBot {
  private socket: SocketLike | null = null
  private tokens: TenantTokenProvider | null = null
  private connected = false
  private reconnectDelay = 2_000
  private stopped = false
  private hold = false

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socketCtor: SocketCtor = defaultCtor as unknown as SocketCtor,
  ) {}


  /**
   * (Re)evaluates whether the bot should be connected based on current config.
   * Safe to call on every config change: it connects, disconnects, or no-ops as
   * appropriate.
   */
  async reconcile(): Promise<void> {
    const config = await getFeishuConfig()
    const wanted =
      config.botEnabled && config.appId.length > 0 && config.appSecret.length > 0

    if (!wanted) {
      this.stop()
      return
    }
    if (this.connected) return
    this.stopped = false
    this.tokens = new TenantTokenProvider(config.appId, config.appSecret, this.fetchImpl)
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.connected = false
    if (this.hold) {
      this.hold = false
      release()
    }
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new this.socketCtor(ENDPOINT)
    this.socket = socket

    socket.onopen = (): void => {
      this.connected = true
      this.reconnectDelay = 2_000
      if (!this.hold) {
        this.hold = true
        retain()
      }
    }

    socket.onmessage = (event: MessageEvent): void => {
      void this.handleMessage(event.data).catch((error: unknown) => {
        console.warn('[Browser Copilot] feishu message handling failed', error)
      })
    }

    socket.onclose = (): void => {
      this.connected = false
      if (this.hold) {
        this.hold = false
        release()
      }
      if (this.stopped) return
      // Backoff: double up to 30 s.
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2)
    }

    socket.onerror = (): void => {
      // onclose follows; close/reconnect logic lives there.
    }
  }

  /**
   * Handles one inbound frame.
   *
   * Feishu's long-connection protocol wraps events; this implements the minimal
   * subset needed to recognise a text message in a DM or group and act on it.
   * Unknown frames are ignored rather than rejected, so a future protocol nuance
   * degrades to "no action", not a crash.
   */
  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'string' || !this.tokens) return
    let frame: {
      type?: string
      header?: { event_type?: string; token?: string }
      event?: {
        message?: { chat_id?: string; content?: string; message_type?: string }
        sender?: { sender_id?: { open_id?: string } }
      }
    }
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }

    // The long-conn handshake/control frames use various `type` values; only an
    // event frame carries a message.
    if (frame.header?.event_type !== 'im.message.receive_v1') return

    const message = frame.event?.message
    if (message?.message_type !== 'text' || !message.chat_id) return

    let text = ''
    try {
      text = (JSON.parse(message.content ?? '{}') as { text?: string }).text ?? ''
    } catch {
      return
    }
    text = text.trim()
    if (!isCommand(text)) return

    const token = await this.tokens.get()
    // Match the review task first, then any task whose name appears in the text.
    const tasks = await listTasks()
    const reviewTask = tasks.find((task) => task.kind === 'github-review-requests')
    const named =
      tasks.find((task) => task.name && text.toLowerCase().includes(task.name.toLowerCase())) ??
      reviewTask

    if (!named) {
      await safeReply(token, message.chat_id, this.noTaskReply(text))
      return
    }

    await safeReply(token, message.chat_id, this.ackReply(named.name, text))
    try {
      const outcome = await triggerNow(named.id, 'feishu')
      // triggerNow already records/notifies per task config; send a direct reply
      // as well, so the requester sees the answer in the chat that asked.
      await sendImText(token, message.chat_id, outcome.summary || '(no output)')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await safeReply(token, message.chat_id, `Task failed: ${detail}`)
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
