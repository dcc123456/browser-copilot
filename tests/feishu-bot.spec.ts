import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FeishuBot } from '../src/background/feishu-bot'
import {
  decodeFrame,
  encodeFrame,
  header,
  METHOD,
  CTRL,
  DATA,
} from '../src/lib/feishu-proto'

/** Builds a server→client data event frame carrying a Feishu event callback. */
function eventFrame(seqId: bigint, eventJson: string, service = 33554678): Uint8Array {
  return encodeFrame({
    seqId,
    logId: seqId + 1000n,
    service,
    method: METHOD.DATA,
    headers: [
      { key: 'type', value: DATA.EVENT },
      { key: 'message_id', value: 'om_evt' },
      { key: 'seq', value: String(Number(seqId)) },
    ],
    payload: new TextEncoder().encode(eventJson),
  })
}

/** Builds a server→client control ping frame. */
function pingFrame(service = 33554678): Uint8Array {
  return encodeFrame({
    seqId: 0n,
    logId: 0n,
    service,
    method: METHOD.CONTROL,
    headers: [{ key: 'type', value: CTRL.PING }],
    payload: new TextEncoder().encode(JSON.stringify({ PingInterval: 90 })),
  })
}

let eventCounter = 0
function textMessageEvent(text: string, senderType = 'user'): string {
  eventCounter += 1
  return JSON.stringify({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', event_id: `evt_${eventCounter}` },
    event: {
      sender: {
        sender_type: senderType,
        sender_id: { open_id: senderType === 'app' ? 'ou_bot' : 'ou_user' },
      },
      message: {
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text }),
        message_id: `om_${eventCounter}`,
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
    FakeSocket.createdCount = 0
  }
}

// The real discovery response shape: data.URL + ClientConfig.PingInterval.
const ENDPOINT_JSON = {
  code: 0,
  data: {
    URL: 'wss://msg-frontier.feishu.cn/ws/v2?service_id=33554678&device_id=dev123&access_key=k&ticket=t',
    ClientConfig: { PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 90, ReconnectNonce: 25 },
  },
}
const TOKEN_JSON = { code: 0, tenant_access_token: 't-ten', expire: 7200 }

describe('FeishuBot connection state machine', () => {
  beforeEach(() => {
    FakeSocket.reset()
    eventCounter = 0
    vi.clearAllMocks()
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
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/tenant_access_token')) return fakeResponse(TOKEN_JSON)
      if (typeof url === 'string' && url.includes('/callback/ws/endpoint')) {
        // The discovery request must authenticate with AppID/AppSecret in the
        // body (NOT a bearer token) and hit the path without /open-apis.
        return fakeResponse(ENDPOINT_JSON)
      }
      if (typeof url === 'string' && url.includes('/im/v1/messages')) return fakeResponse({ code: 0 })
      return new Response('{}', { status: 200 })
    })
    const bot = new FeishuBot(fetchMock as unknown as typeof fetch, FakeSocket as never)
    return { bot, alarms, fetchMock } as ReturnType<typeof makeBot> & {
      fetchMock: ReturnType<typeof vi.fn>
    }
  }

  it('resolves an endpoint via AppID/AppSecret body and opens a socket', async () => {
    const { bot, fetchMock } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    expect(FakeSocket.last).toBeTruthy()
    // Endpoint call goes to /callback/ws/endpoint (no /open-apis).
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/callback/ws/endpoint'))!
    expect(init!.headers).not.toHaveProperty('authorization')
    const body = JSON.parse(init!.body as string) as { AppID: string; AppSecret: string }
    expect(body.AppID).toBe('cli_test')
    expect(body.AppSecret).toBe('sec_test')
    bot.stop()
  })

  it('is connected once the socket opens (no in-band handshake)', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const socket = FakeSocket.last!
    socket.open()
    expect(bot.isConnected()).toBe(true)
    // No handshake frame is sent on open; the first outbound frame is the
    // scheduled ping, not an immediate message.
    bot.stop()
  })

  it('replies to a server ping with a pong echoing the frame metadata', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const socket = FakeSocket.last!
    socket.open()
    const ping = pingFrame(33554678)
    socket.message(ping)
    // The last sent frame is a pong control frame.
    const pong = decodeFrame(socket.sent[socket.sent.length - 1]!)!
    expect(pong.method).toBe(METHOD.CONTROL)
    expect(header(pong, 'type')).toBe(CTRL.PONG)
    expect(pong.service).toBe(33554678)
    bot.stop()
  })

  it('reconnects with exponential backoff after an unexpected close', async () => {
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.runAllTimersAsync()
    const first = FakeSocket.last!
    first.open()
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
    const socket = FakeSocket.last!
    socket.closed = true
    socket.closeEvent(1011, 'worker evicted')
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
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 2000 })
    const socket = FakeSocket.last!
    socket.open()

    const unattended = await import('../src/background/agent-unattended')
    const runSpy = vi.mocked(unattended.runUnattendedPrompt)

    socket.message(eventFrame(55n, textMessageEvent('帮我查看微博现在的热搜是什么')))
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1), { timeout: 2000 })

    // The event must be ACKed with a data frame echoing seqId 55 and code 0.
    const ack = decodeFrame(socket.sent[socket.sent.length - 1]!)!
    expect(ack.method).toBe(METHOD.DATA)
    expect(ack.seqId).toBe(55n)
    const body = JSON.parse(new TextDecoder().decode(ack.payload)) as { code: number }
    expect(body.code).toBe(200)

    const [prompt, convoId, mode] = runSpy.mock.calls[0]!
    expect(prompt).toContain('微博')
    expect(convoId).toContain('feishu:')
    expect(mode).toBe('full')
    bot.stop()
  })

  it('runs a redelivered event only once (dedup by event_id)', async () => {
    vi.useRealTimers()
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 2000 })
    const socket = FakeSocket.last!
    socket.open()
    const unattended = await import('../src/background/agent-unattended')
    const runSpy = vi.mocked(unattended.runUnattendedPrompt)
    // Same event payload (same event_id) delivered twice.
    const payload = textMessageEvent('帮我统计 PR')
    socket.message(eventFrame(10n, payload))
    socket.message(eventFrame(11n, payload))
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1), { timeout: 2000 })
    bot.stop()
  })

  it('ignores messages sent by apps/bots to avoid reply loops', async () => {
    vi.useRealTimers()
    const { bot } = makeBot()
    void bot.reconcile()
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 2000 })
    const socket = FakeSocket.last!
    socket.open()
    const unattended = await import('../src/background/agent-unattended')
    const runSpy = vi.mocked(unattended.runUnattendedPrompt)
    socket.message(eventFrame(20n, textMessageEvent('帮我统计 PR', 'app')))
    // Give the async handler a chance to (not) run.
    await new Promise((r) => setTimeout(r, 300))
    expect(runSpy).not.toHaveBeenCalled()
    bot.stop()
  })
})
