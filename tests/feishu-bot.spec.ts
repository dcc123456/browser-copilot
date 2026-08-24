import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FeishuBot } from '../src/background/feishu-bot'
import {
  encodeFrame,
  FRAME,
  encodePong,
  encodeAck,
  decodeMessage,
} from '../src/lib/feishu-proto'

/** Builds a server request (type 1) frame carrying a Feishu event callback. */
function eventFrame(seq: number, eventJson: string): Uint8Array {
  // Field 4 (Data) is a length-delimited string in ServerStreamResponse. Encode
  // the length as a proper varint so long payloads parse correctly.
  const s = new TextEncoder().encode(eventJson)
  const lenBytes: number[] = []
  let len = s.length
  do {
    const byte = len & 0x7f
    len >>>= 7
    lenBytes.push(len > 0 ? byte | 0x80 : byte)
  } while (len > 0)
  const payload = new Uint8Array(1 + lenBytes.length + s.length)
  payload[0] = (4 << 3) | 2
  payload.set(lenBytes, 1)
  payload.set(s, 1 + lenBytes.length)
  return encodeFrame(FRAME.REQUEST, seq, payload)
}

function textMessageEvent(text: string): string {
  return JSON.stringify({
    header: { event_type: 'im.message.receive_v1', event_id: 'e1' },
    event: {
      message: {
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text }),
        message_id: 'om_1',
      },
    },
  })
}

// Mock the task-store and scheduler so the bot's event routing has no side
// effects; this test focuses purely on the connection state machine.
vi.mock('../src/lib/task-store', () => ({
  getFeishuConfig: vi.fn(async () => ({
    webhookUrl: '',
    webhookSecret: '',
    appId: 'cli_test',
    appSecret: 'sec_test',
    botEnabled: true,
  })),
  listTasks: vi.fn(async () => []),
}))
vi.mock('../src/background/scheduler', () => ({
  triggerNow: vi.fn(async () => ({ ok: true, summary: 'done', error: null, skipped: false })),
}))
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: vi.fn(async () => ({ ok: true, answer: '42', error: undefined })),
}))

/** Fake alarm API that records created alarms so the test can fire them. */
function fakeAlarms() {
  const alarms = new Map<string, { periodInMinutes?: number }>()
  return {
    alarms,
    api: {
      create: vi.fn(async (name: string, info: { periodInMinutes?: number }) => {
        alarms.set(name, info)
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
  }
}

function fakeResponse(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200 })
}

/** A controllable fake WebSocket. */
class FakeSocket {
  static last: FakeSocket | null = null
  static failOpen = false
  static openEndpoint = ''
  static createdCount = 0
  binaryType = ''
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: Uint8Array[] = []
  closed = false
  constructor(public url: string) {
    FakeSocket.last = this
    FakeSocket.createdCount += 1
    FakeSocket.openEndpoint = url
  }
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  // Test helpers to drive the socket.
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  message(data: Uint8Array): void {
    this.onmessage?.({ data })
  }
  closeEvent(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  static reset(): void {
    FakeSocket.last = null
    FakeSocket.failOpen = false
    FakeSocket.openEndpoint = ''
    FakeSocket.createdCount = 0
  }
}

const ENDPOINT_JSON = {
  code: 0,
  data: {
    WebSocket: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?token=tok123' },
    ClientId: 'cid-abc',
    HeartbeatInterval: 120,
  },
}

const TOKEN_JSON = { code: 0, tenant_access_token: 't-ten', expire: 7200 }

describe('FeishuBot connection state machine', () => {
  beforeEach(() => {
    FakeSocket.reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeBot(): { bot: FeishuBot; alarms: ReturnType<typeof fakeAlarms> } {
    const alarms = fakeAlarms()
    ;(globalThis as { chrome: unknown }).chrome = {
      runtime: { getPlatformInfo: vi.fn(async () => ({})) },
      alarms: alarms.api,
    }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/tenant_access_token')) return fakeResponse(TOKEN_JSON)
      if (url.includes('/callback/ws/endpoint')) return fakeResponse(ENDPOINT_JSON)
      if (url.includes('/im/v1/messages')) return fakeResponse({ code: 0 })
      return new Response('{}', { status: 200 })
    })
    const bot = new FeishuBot(fetchMock as unknown as typeof fetch, FakeSocket as never)
    return { bot, alarms }
  }

  it('resolves an endpoint, opens a socket, and sends a handshake on open', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    // Let the endpoint HTTP call resolve.
    await vi.runAllTimersAsync()
    const socket = FakeSocket.last!
    expect(socket).toBeTruthy()
    expect(socket.url).toContain('token=tok123')
    socket.open()
    // The first frame sent must be a request frame with the handshake method in
    // field 2 and the handshake JSON in field 6.
    const first = socket.sent[0]!
    expect(first[1]).toBe(FRAME.REQUEST)
    const msg = decodeMessage(first.subarray(8))
    expect(msg.strings.get(2)).toBe('v2:handshake')
    const body = JSON.parse(msg.strings.get(6)!)
    expect(body.ClientId).toBe('cid-abc')
    expect(body.Token).toBe('tok123')
    expect(msg.strings.get(8)).toBe('cli_test')
    bot.stop()
  })

  it('treats a code-0 response frame as a successful handshake', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const socket = FakeSocket.last!
    socket.open()
    // Build a response frame: field 2 (code) varint = 0.
    const okPayload = new Uint8Array([(2 << 3) | 0, 0])
    socket.message(encodeFrame(FRAME.RESPONSE, 1, okPayload))
    expect(bot.isConnected()).toBe(true)
    bot.stop()
  })

  it('replies to a ping with a pong echoing the sequence id', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const socket = FakeSocket.last!
    socket.open()
    socket.message(encodeFrame(FRAME.RESPONSE, 1, new Uint8Array([(2 << 3) | 0, 0])))
    // Server pings with seq 0xdeadbeef.
    socket.message(encodeFrame(FRAME.PING, 0xdeadbeef, new Uint8Array()))
    const pong = socket.sent[socket.sent.length - 1]!
    const view = new DataView(pong.buffer)
    expect(pong[1]).toBe(FRAME.PONG)
    expect(view.getUint32(4, false)).toBe(0xdeadbeef)
    // Sanity: our encoder agrees.
    expect(pong).toEqual(encodePong(0xdeadbeef))
    bot.stop()
  })

  it('reconnects with exponential backoff after an unexpected close', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const first = FakeSocket.last!
    first.open()
    first.message(encodeFrame(FRAME.RESPONSE, 1, new Uint8Array([(2 << 3) | 0, 0])))
    expect(bot.isConnected()).toBe(true)
    first.closeEvent(1006)
    expect(bot.isConnected()).toBe(false)
    // No new socket yet: backoff is ~2s.
    expect(FakeSocket.createdCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2_001)
    await vi.runAllTimersAsync()
    expect(FakeSocket.createdCount).toBe(2)
    bot.stop()
  })

  it('arms a periodic watchdog alarm and reconnects when it fires while disconnected', async () => {
    const { bot, alarms } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    expect(alarms.alarms.has('feishu-bot-watchdog')).toBe(true)
    expect(alarms.alarms.get('feishu-bot-watchdog')!.periodInMinutes).toBe(1)
    // Drop the socket without scheduling a reconnect (simulate a dead worker).
    const socket = FakeSocket.last!
    socket.closed = true
    // Force the guard state to disconnected.
    socket.closeEvent(1011, 'worker evicted')
    // Burn the in-memory backoff timer to isolate the watchdog path.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.runAllTimersAsync()
    const before = FakeSocket.createdCount
    bot.onWatchdog()
    await vi.runAllTimersAsync()
    expect(FakeSocket.createdCount).toBeGreaterThan(before)
    bot.stop()
    expect(alarms.alarms.has('feishu-bot-watchdog')).toBe(false)
  })

  it('does nothing when the bot is disabled', async () => {
    const alarms = fakeAlarms()
    ;(globalThis as { chrome: unknown }).chrome = {
      runtime: { getPlatformInfo: vi.fn(async () => ({})) },
      alarms: alarms.api,
    }
    const store = await import('../src/lib/task-store')
    vi.mocked(store.getFeishuConfig).mockResolvedValueOnce({
      webhookUrl: '', webhookSecret: '', appId: '', appSecret: '', botEnabled: false,
    })
    const bot = new FeishuBot(
      vi.fn(async () => new Response('{}')) as unknown as typeof fetch,
      FakeSocket as never,
    )
    await bot.reconcile()
    expect(FakeSocket.createdCount).toBe(0)
    bot.onWatchdog()
    expect(FakeSocket.createdCount).toBe(0)
  })

  it('routes an unrecognised message to the ad-hoc agent and ACKs it', async () => {
    vi.useRealTimers()
    const { bot } = makeBot()
    void bot.reconcile()
    // The endpoint/token fetches are mocked but still resolve on the microtask
    // queue; wait until the socket constructor has run.
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 2000 })
    const socket = FakeSocket.last!
    socket.open()
    // Handshake ok.
    socket.message(encodeFrame(FRAME.RESPONSE, 1, new Uint8Array([(2 << 3) | 0, 0])))

    const unattended = await import('../src/background/agent-unattended')
    const runSpy = vi.mocked(unattended.runUnattendedPrompt)

    socket.message(eventFrame(55, textMessageEvent('帮我查看微博现在的热搜是什么')))
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1), { timeout: 2000 })

    // The event must be ACKed with a response frame echoing seq 55.
    const ack = socket.sent.find((bytes) => bytes[1] === FRAME.RESPONSE)
    expect(ack).toBeTruthy()
    const view = new DataView(ack!.buffer)
    expect(view.getUint32(4, false)).toBe(55)

    const [prompt, convoId, mode] = runSpy.mock.calls[0]!
    expect(prompt).toContain('微博')
    expect(convoId).toContain('feishu:')
    expect(mode).toBe('full')
    bot.stop()
  })
})
