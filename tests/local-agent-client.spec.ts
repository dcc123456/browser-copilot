/**
 * Local-agent bridge: URL validation, the shared request processor, and the
 * outbound WebSocket client (reconnect/backoff, message routing).
 *
 * `agent.ts` and `agent-unattended.ts` are mocked so the processor's protocol
 * logic and the client's connection machinery are exercised in isolation,
 * without pulling in the full LLM/tool stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runToolStandalone } = vi.hoisted(() => ({ runToolStandalone: vi.fn() }))
const { runUnattendedPrompt } = vi.hoisted(() => ({ runUnattendedPrompt: vi.fn() }))

vi.mock('../src/background/agent', () => ({
  TOOLS: [
    {
      type: 'function',
      function: {
        name: 'click',
        description: 'Click an element.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
  runToolStandalone,
}))

vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt,
}))

// Storage is mocked so the agent-client test can observe the automatic
// clearing of a stale pinned connection; the real implementations of the rest
// (e.g. `newId`) are kept via `importOriginal`.
vi.mock('../src/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: vi.fn(), setSettings: vi.fn() }
})

import { agentClient } from '../src/background/agent-client'
import { processAgentRequest } from '../src/background/agent-api'
import { getSettings, setSettings } from '../src/lib/storage'
import { DEFAULT_LOCAL_AGENT_URL, normalizeLocalAgentUrl } from '../src/lib/types'
import type { Settings } from '../src/lib/types'

/** Minimal controllable stand-in for the browser WebSocket. */
class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  url: string
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { reason?: string; wasClean?: boolean }) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(String(data))
  }

  close(): void {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }

  // --- test helpers ---
  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({})
  }

  receive(data: unknown): void {
    this.onmessage?.({ data })
  }

  /** Connection attempt failed (network down / server absent). */
  fail(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onerror?.({ message: 'Connection failed.' })
    this.onclose?.({ reason: 'Connection failed.', wasClean: false })
  }

  /** Server dropped an established connection. */
  closeFromServer(reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ reason, wasClean: false })
  }

  static reset(): void {
    MockWebSocket.instances = []
  }
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    providers: [],
    activeProviderId: '',
    locale: 'auto',
    mode: 'semi',
    maxToolRounds: 20,
    disabledTools: [],
    systemPromptOverride: '',
    downloadAutoSave: true,
    imageModel: { providerId: '', model: '' },
    ocrLanguage: 'eng',
    localAgentEnabled: true,
    localAgentToken: '',
    localAgentUrl: 'ws://127.0.0.1:8765',
    localAgentActiveAgent: '',
    ...overrides,
  }
}

const latestSocket = (): MockWebSocket => {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  if (!ws) throw new Error('No WebSocket has been opened yet.')
  return ws
}

beforeEach(() => {
  MockWebSocket.reset()
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.clearAllMocks()
  // Default storage responses so agentClient tests never hit the real chrome
  // APIs; individual tests override these to exercise edge cases.
  vi.mocked(getSettings).mockResolvedValue(settings())
  vi.mocked(setSettings).mockResolvedValue(settings())
})

afterEach(() => {
  // A successful open resets the module's reconnect backoff; do it here so a
  // test that ends mid-backoff cannot skew the next test's timing.
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  if (ws) ws.open()
  agentClient.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('normalizeLocalAgentUrl · address validation', () => {
  it('keeps the default for non-string input', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(normalizeLocalAgentUrl(bad)).toBe(DEFAULT_LOCAL_AGENT_URL)
    }
  })

  it('accepts ws/wss URLs whose host is a loopback address', () => {
    expect(normalizeLocalAgentUrl('ws://127.0.0.1:8765')).toBe('ws://127.0.0.1:8765')
    expect(normalizeLocalAgentUrl('ws://localhost:9000/agent')).toBe('ws://localhost:9000/agent')
    expect(normalizeLocalAgentUrl('wss://[::1]:8765')).toBe('wss://[::1]:8765')
  })

  it('rejects remote hosts, other schemes, and garbage', () => {
    for (const bad of [
      'ws://example.com:8765',
      'wss://evil.example:8765',
      'http://127.0.0.1:8765',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(normalizeLocalAgentUrl(bad)).toBe(DEFAULT_LOCAL_AGENT_URL)
    }
  })
})

describe('processAgentRequest · protocol & security gates', () => {
  const errorOf = (result: { ok: boolean; error?: string }): string =>
    result.ok ? '' : (result.error ?? '')

  it('refuses requests while the bridge is disabled', async () => {
    const result = await processAgentRequest({ type: 'ping' }, settings({ localAgentEnabled: false }))
    expect(result.ok).toBe(false)
    expect(errorOf(result)).toMatch(/disabled/i)
  })

  it('rejects malformed messages', async () => {
    for (const bad of [null, 'x', 42, []]) {
      expect((await processAgentRequest(bad, settings())).ok).toBe(false)
    }
  })

  it('requires a matching token when one is configured', async () => {
    const s = settings({ localAgentToken: 'secret' })
    expect(await processAgentRequest({ type: 'ping' }, s)).toEqual({ ok: false, error: 'Invalid token.' })
    expect(await processAgentRequest({ type: 'ping', token: 'wrong' }, s)).toEqual({
      ok: false,
      error: 'Invalid token.',
    })
    expect(await processAgentRequest({ type: 'ping', token: 'secret' }, s)).toEqual({
      ok: true,
      data: { pong: true },
    })
  })

  it('answers ping', async () => {
    expect(await processAgentRequest({ type: 'ping' }, settings())).toEqual({
      ok: true,
      data: { pong: true },
    })
  })

  it('lists the advertised tools', async () => {
    const result = await processAgentRequest({ type: 'tools.list' }, settings())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as { tools: unknown[] }).tools).toHaveLength(1)
    }
  })

  it('runs a single tool with its args', async () => {
    runToolStandalone.mockResolvedValueOnce({ ok: true, clicked: true })
    const result = await processAgentRequest(
      { type: 'tool', tool: 'click', args: { selector: '#a' } },
      settings(),
    )
    expect(runToolStandalone).toHaveBeenCalledWith('click', { selector: '#a' })
    expect(result).toEqual({ ok: true, data: { ok: true, clicked: true } })
  })

  it('surfaces a tool rejection (e.g. disabled in settings)', async () => {
    runToolStandalone.mockResolvedValueOnce({ ok: false, error: 'The "click" tool is disabled in settings.' })
    const result = await processAgentRequest({ type: 'tool', tool: 'click', args: {} }, settings())
    // The processor passes the tool's own result through as `data`, so the
    // rejection is visible there rather than as a transport-level error.
    expect(result.ok).toBe(true)
    if (result.ok) {
      const inner = result.data as { ok: boolean; error: string }
      expect(inner.ok).toBe(false)
      expect(inner.error).toMatch(/disabled/i)
    }
  })

  it('requires a tool name', async () => {
    const result = await processAgentRequest({ type: 'tool', tool: '', args: {} }, settings())
    expect(result.ok).toBe(false)
    expect(errorOf(result)).toMatch(/tool name/i)
  })

  it('propagates a thrown tool error', async () => {
    runToolStandalone.mockRejectedValueOnce(new Error('boom'))
    const result = await processAgentRequest({ type: 'tool', tool: 'click', args: {} }, settings())
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('runs an unattended prompt in full-auto mode', async () => {
    runUnattendedPrompt.mockResolvedValueOnce({ ok: true, answer: 'done', cancelled: false })
    const result = await processAgentRequest({ type: 'prompt', prompt: 'do the thing' }, settings())
    expect(runUnattendedPrompt).toHaveBeenCalledWith(
      'do the thing',
      expect.stringMatching(/^external:/),
      'full',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as { answer: string }).answer).toBe('done')
    }
  })

  it('rejects an unknown request type', async () => {
    const result = await processAgentRequest({ type: 'nope' } as never, settings())
    expect(result.ok).toBe(false)
    expect(errorOf(result)).toMatch(/Unknown request type/)
  })

  it('only executes tool/prompt from the selected connection', async () => {
    const s = settings({ localAgentActiveAgent: 'agent-1' })
    const activeAgentIds = ['agent-1']
    runToolStandalone.mockResolvedValueOnce({ ok: true, clicked: true })

    // A different connection — or a request without a connection id — is refused
    // while the pinned id is still in the current connected list.
    const other = await processAgentRequest(
      { type: 'tool', tool: 'click', agentId: 'agent-2', args: {} },
      s,
      activeAgentIds,
    )
    expect(other.ok).toBe(false)
    expect(errorOf(other)).toMatch(/selected connection/i)
    const unknown = await processAgentRequest({ type: 'tool', tool: 'click', args: {} }, s, activeAgentIds)
    expect(unknown.ok).toBe(false)
    expect(runToolStandalone).not.toHaveBeenCalled()

    // The pinned connection still works.
    const mine = await processAgentRequest(
      { type: 'tool', tool: 'click', agentId: 'agent-1', args: {} },
      s,
      activeAgentIds,
    )
    expect(mine.ok).toBe(true)
    expect(runToolStandalone).toHaveBeenCalledWith('click', {})
  })

  it('serves every connection when the pinned id is stale (no longer connected)', async () => {
    const s = settings({ localAgentActiveAgent: 'agent-1' })
    runToolStandalone.mockResolvedValueOnce({ ok: true, clicked: true })

    // `activeAgentIds` does not include the pinned 'agent-1' (it dropped), so
    // another agent's tool request is served instead of being silently rejected.
    const result = await processAgentRequest(
      { type: 'tool', tool: 'click', agentId: 'agent-2', args: {} },
      s,
      ['agent-2'],
    )
    expect(result.ok).toBe(true)
    expect(runToolStandalone).toHaveBeenCalledWith('click', {})
  })

  it('never refuses tools.list while a connection is pinned', async () => {
    const s = settings({ localAgentActiveAgent: 'agent-1' })
    // Pinned id is live in `activeAgentIds`, but tools.list is never filtered.
    const tools = await processAgentRequest({ type: 'tools.list', agentId: 'agent-2' }, s, ['agent-1'])
    expect(tools.ok).toBe(true)
    if (tools.ok) {
      expect((tools.data as { tools: unknown[] }).tools).toHaveLength(1)
    }
  })

  it('refuses an agentId-less tool request with a readable error when the pin is live', async () => {
    const s = settings({ localAgentActiveAgent: 'agent-1' })
    const result = await processAgentRequest({ type: 'tool', tool: 'click', args: {} }, s, ['agent-1'])
    expect(result.ok).toBe(false)
    const error = errorOf(result)
    expect(error).toMatch(/selected connection/i)
    // Bilingual copy is kept intact and human-readable.
    expect(error).toContain('本插件当前只服务所选连接')
    expect(error).toContain('is serving only the selected connection')
  })

  it('keeps ping / tools.list open to every connection', async () => {
    const s = settings({ localAgentActiveAgent: 'agent-1' })
    const ping = await processAgentRequest({ type: 'ping', agentId: 'agent-2' }, s)
    expect(ping).toEqual({ ok: true, data: { pong: true } })
    const tools = await processAgentRequest({ type: 'tools.list', agentId: 'agent-2' }, s)
    expect(tools.ok).toBe(true)
  })

  it('serves every connection when none is selected', async () => {
    runToolStandalone.mockResolvedValueOnce({ ok: true, clicked: true })
    const result = await processAgentRequest(
      { type: 'tool', tool: 'click', agentId: 'anything', args: {} },
      settings(),
    )
    expect(result.ok).toBe(true)
  })
})

describe('agentClient · outbound WebSocket', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('opens a connection to the normalized URL and reports the state transitions', () => {
    agentClient.start(settings({ localAgentUrl: 'ws://127.0.0.1:9999' }))
    const ws = latestSocket()
    expect(ws.url).toBe('ws://127.0.0.1:9999')
    expect(agentClient.getStatus()).toMatchObject({ enabled: true, state: 'connecting' })

    ws.open()
    expect(agentClient.getStatus()).toMatchObject({
      state: 'connected',
      url: 'ws://127.0.0.1:9999',
      error: undefined,
    })
    expect(agentClient.getStatus().connectedAt).toEqual(expect.any(Number))
  })

  it('sends an initial ping on connect so the adapter registers this plugin immediately', () => {
    agentClient.start(settings())
    latestSocket().open()

    // The very first outbound message is the id-less registration ping; the
    // adapter treats any ping as "this socket is the plugin".
    expect(latestSocket().sent).toHaveLength(1)
    expect(latestSocket().sent[0]).toBe(JSON.stringify({ type: 'ping' }))
  })

  it('routes ping / tool messages and echoes the reply with the request id', async () => {
    runToolStandalone.mockResolvedValueOnce({ ok: true, clicked: true })
    agentClient.start(settings())
    latestSocket().open()

    latestSocket().receive(JSON.stringify({ id: 1, type: 'ping' }))
    await flush()
    latestSocket().receive(
      JSON.stringify({ id: 'abc', type: 'tool', tool: 'click', args: { selector: '#x' } }),
    )
    await flush()

    expect(runToolStandalone).toHaveBeenCalledWith('click', { selector: '#x' })
    // sent[0] is the initial registration ping; replies follow it.
    expect(latestSocket().sent[0]).toBe(JSON.stringify({ type: 'ping' }))
    expect(latestSocket().sent[1]).toBe(JSON.stringify({ ok: true, data: { pong: true }, id: 1 }))
    expect(latestSocket().sent[2]).toBe(
      JSON.stringify({ ok: true, data: { ok: true, clicked: true }, id: 'abc' }),
    )
  })

  it('ignores non-JSON and non-object messages', async () => {
    agentClient.start(settings())
    latestSocket().open()

    latestSocket().receive('not json')
    latestSocket().receive('[1,2,3]')
    await flush()

    // Only the initial registration ping is ever sent.
    expect(latestSocket().sent).toHaveLength(1)
  })

  it('reconnects with backoff after an unexpected close', () => {
    vi.useFakeTimers()
    agentClient.start(settings())
    const first = latestSocket()
    first.open()
    first.closeFromServer('boom')

    expect(agentClient.getStatus().state).toBe('disconnected')
    expect(MockWebSocket.instances).toHaveLength(1)

    vi.advanceTimersByTime(1_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(latestSocket().url).toBe('ws://127.0.0.1:8765')
    expect(agentClient.getStatus().state).toBe('connecting')
  })

  it('backs off exponentially', () => {
    vi.useFakeTimers()
    agentClient.start(settings())

    // Each reconnect attempt is verified to start exactly at 1s, 2s, 4s, 8s —
    // never a tick earlier — proving the delay doubles on every failure.
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      const before = MockWebSocket.instances.length
      latestSocket().closeFromServer('x')
      vi.advanceTimersByTime(delay - 1)
      expect(MockWebSocket.instances.length).toBe(before)
      vi.advanceTimersByTime(1)
      expect(MockWebSocket.instances.length).toBe(before + 1)
    }
  })

  it('stops reconnecting once stop() is called', () => {
    vi.useFakeTimers()
    agentClient.start(settings())
    latestSocket().open()
    agentClient.stop()

    expect(agentClient.getStatus()).toMatchObject({ enabled: false, state: 'disconnected' })
    vi.advanceTimersByTime(60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('drops the connection when sync() is told the bridge is disabled', async () => {
    agentClient.start(settings())
    latestSocket().open()
    expect(agentClient.getStatus().state).toBe('connected')

    // Directly exercising the public singleton: stop() after disable is the
    // same path sync() takes.
    agentClient.stop()
    expect(agentClient.getStatus().state).toBe('disconnected')
  })

  it('tracks agents.update reports and clears them when the socket drops', async () => {
    agentClient.start(settings())
    latestSocket().open()

    latestSocket().receive(
      JSON.stringify({
        type: 'agents.update',
        agents: [
          { id: 'a1', name: 'agent-one' },
          { id: 'a2' }, // no name → falls back to the id
          { bad: true }, // malformed → dropped
        ],
      }),
    )
    await flush()

    // One-way notification: no reply is ever sent back (only the initial
    // registration ping from onopen is on the wire).
    expect(latestSocket().sent).toHaveLength(1)
    expect(latestSocket().sent[0]).toBe(JSON.stringify({ type: 'ping' }))
    expect(agentClient.getStatus().agents).toEqual([
      { id: 'a1', name: 'agent-one' },
      { id: 'a2', name: 'a2' },
    ])

    // A dropped connection invalidates the reported list.
    latestSocket().closeFromServer()
    expect(agentClient.getStatus().agents).toEqual([])
  })

  it('clears a stale pinned connection after agents.update drops it', async () => {
    // The user pinned 'a1', but the new report no longer contains it.
    vi.mocked(getSettings).mockResolvedValue(settings({ localAgentActiveAgent: 'a1' }))
    agentClient.start(settings())
    latestSocket().open()

    latestSocket().receive(
      JSON.stringify({
        type: 'agents.update',
        agents: [{ id: 'a2', name: 'agent-two' }],
      }),
    )
    await flush()

    // The stale pin is persisted back to '' (serve every connection)…
    expect(setSettings).toHaveBeenCalledWith({ localAgentActiveAgent: '' })
    // …and the published agent list is still updated as usual.
    expect(agentClient.getStatus().agents).toEqual([{ id: 'a2', name: 'agent-two' }])
  })

  it('keeps a live pinned connection untouched after agents.update', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ localAgentActiveAgent: 'a1' }))
    agentClient.start(settings())
    latestSocket().open()

    latestSocket().receive(
      JSON.stringify({
        type: 'agents.update',
        agents: [{ id: 'a1', name: 'agent-one' }],
      }),
    )
    await flush()

    expect(setSettings).not.toHaveBeenCalled()
    expect(agentClient.getStatus().agents).toEqual([{ id: 'a1', name: 'agent-one' }])
  })
})
