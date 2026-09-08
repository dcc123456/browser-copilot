/**
 * The server's Feishu trigger bot — a Node port of the extension's
 * `background/feishu-bot.ts` long connection, with the minimal command set
 * needed to run workflows remotely.
 *
 * Protocol (identical to the extension): endpoint discovery with app
 * credentials, one binary WebSocket carrying pbbp2 frames (pure codecs from
 * `lib/feishu-proto.ts`), ping/pong on the server's interval, ACK-first event
 * handling with redelivery dedupe, exponential reconnect.
 *
 * Commands:
 * - `/workflow <名称或id>`（或 `运行工作流 …`）→ run + report result
 * - `/runs` → the latest runs
 * - `/help`
 *
 * @module server/feishu-bot
 */

import WebSocket from 'ws'
import {
  TenantTokenProvider,
  getWsEndpoint,
  sendImText,
} from '../../src/lib/feishu'
import {
  CTRL,
  DATA,
  METHOD,
  decodeFrame,
  encodeAck,
  encodeFrame,
  encodePing,
  header,
  parseEvent,
  type Frame,
  type InboundMessage,
} from '../../src/lib/feishu-proto'
import type { RunnerConfig } from './config'
import type { RunService } from './run-service'
import type { WorkflowLibrary } from './workflow-library'
import type { Workflow } from '../../src/lib/workflow/types'

/** How long a run may take before the bot stops waiting for its result. */
const RESULT_WAIT_MS = 10 * 60_000
const RESULT_POLL_MS = 2_000

/** Matches a run-workflow command (same wording as the extension bot). */
const WORKFLOW_COMMAND = /^\s*(?:\/run\s+workflow|\/workflow|运行工作流|执行工作流)[：: ]?\s*(.+)$/i

export class FeishuBot {
  private socket: WebSocket | null = null
  private stopped = false
  private reconnectDelayMs = 2_000
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private serviceId = 0
  private readonly token: TenantTokenProvider
  private seenEvents = new Set<string>()

  constructor(
    private readonly config: RunnerConfig,
    private readonly library: WorkflowLibrary,
    private readonly runs: RunService,
  ) {
    this.token = new TenantTokenProvider(config.feishu.appId, config.feishu.appSecret)
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.stopPing()
    this.socket?.close(1000, 'server stopping')
    this.socket = null
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const endpoint = await getWsEndpoint(this.config.feishu.appId, this.config.feishu.appSecret)
      this.serviceId = endpoint.serviceId
      const socket = new WebSocket(endpoint.url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      socket.on('open', () => {
        this.reconnectDelayMs = 2_000
        console.log('[feishu] long connection established')
        this.startPing(endpoint.pingIntervalSeconds)
      })
      socket.on('message', (data: WebSocket.RawData) => {
        try {
          this.onMessage(data)
        } catch (error) {
          console.warn('[feishu] frame handling failed:', (error as Error).message)
        }
      })
      socket.on('error', () => {
        /* onclose follows */
      })
      socket.on('close', (code, reason) => {
        this.stopPing()
        this.socket = null
        if (!this.stopped) {
          console.log(`[feishu] socket closed (${code}${reason ? ` ${reason}` : ''}); reconnecting in ${this.reconnectDelayMs}ms`)
          this.scheduleReconnect()
        }
      })
    } catch (error) {
      console.warn(`[feishu] connect failed: ${(error as Error).message}`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2)
    setTimeout(() => void this.connect(), delay).unref?.()
  }

  private startPing(intervalSeconds: number): void {
    this.stopPing()
    const ms = Math.max(10, intervalSeconds) * 1000
    this.pingTimer = setInterval(() => {
      this.send(encodePing(this.serviceId))
    }, ms)
    this.pingTimer.unref?.()
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    const bytes = toBytes(data)
    if (!bytes) return
    const frame = decodeFrame(bytes)
    if (!frame) return

    if (frame.method === METHOD.CONTROL) {
      if (header(frame, 'type') === CTRL.PING) {
        // Pong echoes the ping's SeqID/LogID/service/headers + payload.
        this.send(
          encodeFrame({
            seqId: frame.seqId,
            logId: frame.logId,
            service: frame.service,
            method: METHOD.CONTROL,
            headers: [{ key: 'type', value: CTRL.PONG }],
            payload: frame.payload,
          }),
        )
      }
      return
    }

    if (frame.method === METHOD.DATA && header(frame, 'type') === DATA.EVENT) {
      this.send(encodeAck(frame))
      const payload = new TextDecoder().decode(frame.payload)
      void this.handleEvent(payload)
    }
  }

  private send(bytes: Uint8Array): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(bytes)
      } catch (error) {
        console.warn('[feishu] send failed:', (error as Error).message)
        this.socket.close()
      }
    }
  }

  private async handleEvent(payload: string): Promise<void> {
    const message = parseEvent(payload)
    if (!message) return
    if (message.eventId && this.seenEvents.has(message.eventId)) return
    if (message.eventId) {
      this.seenEvents.add(message.eventId)
      // Bound the dedupe set.
      if (this.seenEvents.size > 500) {
        this.seenEvents = new Set([...this.seenEvents].slice(-250))
      }
    }
    await this.handleCommand(message)
  }

  private async handleCommand(message: InboundMessage): Promise<void> {
    const text = message.text
    try {
      if (WORKFLOW_COMMAND.test(text)) {
        const nameOrId = (WORKFLOW_COMMAND.exec(text)?.[1] ?? '').trim()
        await this.runWorkflowCommand(message, nameOrId)
        return
      }
      if (/^\s*\/runs\b/i.test(text)) {
        const lines = this.runs
          .list()
          .slice(0, 5)
          .map((run) => `${emoji(run.status)} ${run.label} · ${run.status}${run.error ? ` · ${run.error.slice(0, 80)}` : ''}`)
        await this.reply(message.chatId, lines.length > 0 ? lines.join('\n') : '还没有运行记录')
        return
      }
      await this.reply(
        message.chatId,
        [
          '可用命令：',
          '• /workflow <名称或id> —— 运行一个工作流（也可用 运行工作流）',
          '• /runs —— 最近运行状态',
          '• /help —— 本帮助',
        ].join('\n'),
      )
    } catch (error) {
      console.warn('[feishu] command failed:', (error as Error).message)
      await this.reply(message.chatId, `执行出错: ${(error as Error).message}`).catch(() => {})
    }
  }

  private async runWorkflowCommand(message: InboundMessage, nameOrId: string): Promise<void> {
    const workflow = this.findWorkflow(nameOrId)
    if (!workflow) {
      const available = this.library
        .list()
        .slice(0, 10)
        .map((wf) => `• ${wf.name}`)
        .join('\n')
      await this.reply(
        message.chatId,
        `未找到工作流「${nameOrId}」。\n${available ? `可用的工作流：\n${available}` : '服务器上还没有导入工作流。'}`,
      )
      return
    }

    // Missing children fail at the API layer; the bot surfaces the copy hint.
    const runId = this.runs.start({ workflow, workflowId: workflow.id, source: 'feishu' })
    await this.reply(message.chatId, `▶️ 已开始运行「${workflow.name}」（run ${runId}），完成后回报结果…`)

    const finished = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + RESULT_WAIT_MS
      const timer = setInterval(() => {
        const run = this.runs.get(runId)
        if (!run) return
        if (run.status === 'ok' || run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(timer)
          resolve(true)
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          resolve(false)
        }
      }, RESULT_POLL_MS)
      timer.unref?.()
    })

    const run = this.runs.get(runId)
    if (!finished || !run) {
      await this.reply(message.chatId, `⏳ 工作流「${workflow.name}」仍在运行（run ${runId}），可用 /runs 查看状态。`)
      return
    }
    const tail = run.steps
      .filter((step) => step.kind === 'result' || step.kind === 'error')
      .slice(-3)
      .map((step) => `· ${step.text.slice(0, 120)}`)
      .join('\n')
    if (run.status === 'ok') {
      await this.reply(
        message.chatId,
        `✅ 「${workflow.name}」运行完成${run.summary ? `\n${run.summary}` : ''}${tail ? `\n${tail}` : ''}`,
      )
    } else if (run.status === 'cancelled') {
      await this.reply(message.chatId, `⛔ 「${workflow.name}」已取消`)
    } else {
      await this.reply(
        message.chatId,
        `❌ 「${workflow.name}」运行失败${run.error ? `\n${run.error.slice(0, 300)}` : ''}`,
      )
    }
  }

  /** Exact id → exact name → unique substring match. */
  private findWorkflow(nameOrId: string): Workflow | undefined {
    const all = this.library.list()
    const byId = all.find((wf) => wf.id === nameOrId)
    if (byId) return byId
    const byName = all.filter((wf) => wf.name === nameOrId)
    if (byName.length === 1) return byName[0]
    const contains = all.filter((wf) => wf.name.includes(nameOrId))
    return contains.length === 1 ? contains[0] : byName[0]
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      const token = await this.token.get()
      await sendImText(token, chatId, text)
    } catch (error) {
      console.warn('[feishu] reply failed:', (error as Error).message)
      throw error
    }
  }
}

function emoji(status: string): string {
  if (status === 'ok') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'cancelled') return '⛔'
  return '⏳'
}

function toBytes(data: WebSocket.RawData): Uint8Array | null {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Buffer.isBuffer(data)) return new Uint8Array(data)
  return null
}

/** Starts the bot when configured; returns a stop function. */
export function startFeishuBot(config: RunnerConfig, library: WorkflowLibrary, runs: RunService): FeishuBot {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.warn('[feishu] botEnabled but appId/appSecret missing; bot not started')
    return new FeishuBot(config, library, runs) // inert (start() never called)
  }
  const bot = new FeishuBot(config, library, runs)
  bot.start()
  return bot
}
