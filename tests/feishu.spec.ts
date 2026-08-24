import { describe, expect, it, vi } from 'vitest'
import {
  FeishuError,
  TenantTokenProvider,
  isWebhookUrl,
  sendWebhookText,
  signWebhook,
} from '../src/lib/feishu'

describe('isWebhookUrl', () => {
  it('accepts a valid Feishu hook URL', () => {
    expect(
      isWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abc-123'),
    ).toBe(true)
  })

  it('rejects non-feishu hosts and non-hook paths', () => {
    expect(isWebhookUrl('https://example.com/hook/x')).toBe(false)
    expect(isWebhookUrl('not a url')).toBe(false)
    expect(isWebhookUrl('https://open.feishu.cn/open-apis/im/v1/messages')).toBe(
      false,
    )
  })
})

describe('signWebhook', () => {
  it('produces a non-empty base64 signature for a known secret', async () => {
    // We cannot assert the exact HMAC without replicating it, but we can verify
    // it is deterministic and non-empty, which catches a broken key/encoding path.
    const a = await signWebhook('secret', 1700000000)
    const b = await signWebhook('secret', 1700000000)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(10)
    // Base64 alphabet.
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('changes when the timestamp changes', async () => {
    const a = await signWebhook('secret', 1)
    const b = await signWebhook('secret', 2)
    expect(a).not.toBe(b)
  })
})

describe('sendWebhookText', () => {
  it('rejects an invalid URL before fetching', async () => {
    await expect(sendWebhookText('https://evil.example/x', 'hi')).rejects.toBeInstanceOf(
      FeishuError,
    )
  })

  it('sends msg_type=text and unwraps code 0', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 }),
    )
    // Bind the global fetch for the module under test.
    vi.stubGlobal('fetch', fetchMock)
    try {
      await sendWebhookText(
        'https://open.feishu.cn/open-apis/bot/v2/hook/x',
        'hello',
      )
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.msg_type).toBe('text')
    expect(body.content.text).toBe('hello')
  })

  it('throws FeishuError on a non-zero code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }))),
    )
    try {
      await expect(
        sendWebhookText('https://open.feishu.cn/open-apis/bot/v2/hook/x', 'hi'),
      ).rejects.toMatchObject({ code: 19021 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('TenantTokenProvider', () => {
  it('fetches and caches a token until near expiry', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }),
      ),
    )
    const provider = new TenantTokenProvider('id', 'secret', fetchMock as unknown as typeof fetch)
    expect(await provider.get()).toBe('t-1')
    expect(await provider.get()).toBe('t-1')
    calls = fetchMock.mock.calls.length
    expect(calls).toBe(1) // cached
  })

  it('throws on a non-zero code', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 10003, msg: 'invalid secret' })),
    )
    const provider = new TenantTokenProvider('id', 'bad', fetchMock as unknown as typeof fetch)
    await expect(provider.get()).rejects.toBeInstanceOf(FeishuError)
  })

  it('re-fetches after invalidate', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, tenant_access_token: 't-x', expire: 7200 }),
      ),
    )
    const provider = new TenantTokenProvider('id', 's', fetchMock as unknown as typeof fetch)
    await provider.get()
    provider.invalidate()
    await provider.get()
    expect(fetchMock.mock.calls.length).toBe(2)
  })
})
