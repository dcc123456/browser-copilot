/**
 * Feishu (Lark) messaging client.
 *
 * Two surfaces:
 * - **Custom-bot webhook**: send a text or rich-text card to a group. Needs only
 *   the webhook URL (and optional signing secret). This is what notifications
 *   use and requires no server.
 * - **Long-connection command channel**: receive messages from a person DM'ing a
 *   self-built app. This lives in `background/feishu-bot.ts` because it holds a
 *   persistent socket and belongs in the service worker, not in this pure module.
 *
 * @module lib/feishu
 */

/**
 * Bound wrapper around the global `fetch`.
 *
 * In an MV3 service worker, storing the bare `fetch` as a class field/default
 * argument and later calling it as `this.fetchImpl(...)` loses the global
 * receiver, and Chrome throws "Failed to execute 'fetch' on
 * 'WorkerGlobalScope': Illegal invocation". Calling through this arrow keeps the
 * binding intact. Tests may still inject their own fetch implementation.
 */
export const httpFetch: typeof fetch = (...args) => fetch(...args)

/**
 * Reads a JSON response, but if parsing fails throws with the HTTP status and a
 * short snippet of the raw body.
 *
 * Feishu (or a captive proxy/SSO page in front of it) occasionally returns HTML
 * or a redirect instead of JSON for a misconfigured request; a bare
 * "Unexpected token <" gives no way to tell that from a code bug. Including the
 * status and body preview makes the service-worker log actionable.
 */
async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ')
    throw new FeishuError(
      `${label} returned non-JSON (HTTP ${response.status}): ${snippet}`,
      response.status,
    )
  }
}

/** Thrown when Feishu returns a non-zero code or the request fails. */
export class FeishuError extends Error {
  code: number | string
  constructor(message: string, code: number | string = 'unknown') {
    super(message)
    this.name = 'FeishuError'
    this.code = code
  }
}

/** A webhook URL has the shape `https://open.feishu.cn/open-apis/bot/v2/hook/<uuid>`. */
export function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      (url.host === 'open.feishu.cn' || url.host.endsWith('.feishu.cn')) &&
      url.pathname.includes('/bot/v2/hook/')
    )
  } catch {
    return false
  }
}

/**
 * Computes the HMAC-SHA256 signature Feishu custom bots require when signing is
 * enabled, as a base64 string.
 *
 * `timestamp` is seconds; the string signed is `timestamp\nsecret`.
 */
export async function signWebhook(secret: string, timestamp: number): Promise<string> {
  const data = `${timestamp}\n${secret}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(data),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(0))
  // Feishu's reference impl base64-encodes HMAC(key = "timestamp\nsecret",
  // message = empty). The empty message is what the zero-length buffer above
  // represents — not a typo.
  return bytesToBase64(new Uint8Array(sig))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export interface WebhookResult {
  ok: boolean
  status: number
  body: unknown
}

/**
 * Sends a text message to a Feishu custom-bot webhook.
 *
 * If `secret` is non-empty, the request is signed per Feishu's spec. The webhook
 * URL itself is the bearer credential; callers must not log it.
 */
export async function sendWebhookText(
  webhookUrl: string,
  text: string,
  secret: string = '',
): Promise<WebhookResult> {
  if (!isWebhookUrl(webhookUrl)) {
    throw new FeishuError('The Feishu webhook URL is not valid.', 'invalid-url')
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text },
  }
  if (secret) {
    body.timestamp = String(timestamp)
    body.sign = await signWebhook(secret, timestamp)
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    // Some errors return HTML; keep the status for the caller.
  }
  const code = (parsed as { code?: number } | null)?.code
  if (!response.ok || code !== 0) {
    const msg =
      (parsed as { msg?: string } | null)?.msg ??
      `Feishu returned HTTP ${response.status}`
    throw new FeishuError(msg, code ?? response.status)
  }
  return { ok: true, status: response.status, body: parsed }
}

/**
 * Obtains a tenant access token for a self-built app, caching it until expiry.
 *
 * The token is cached in memory only — the service worker may be evicted at any
 * time, at which point a fresh token is obtained. That is simpler and safer than
 * persisting a token to disk, since a token can be revoked and a stale cached
 * value would cause confusing failures.
 */
export class TenantTokenProvider {
  private token: string | null = null
  private expiresAt = 0

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchImpl: typeof fetch = httpFetch,
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token
    const response = await this.fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      },
    )
    const data = await readJson<{
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }>(response, 'Feishu token request')
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new FeishuError(
        data.msg ?? 'Could not obtain a Feishu tenant access token.',
        data.code ?? response.status,
      )
    }
    this.token = data.tenant_access_token
    this.expiresAt = Date.now() + (data.expire ?? 7200) * 1000
    return this.token
  }

  /** Drops the cached token after an auth failure so the next call re-fetches. */
  invalidate(): void {
    this.token = null
    this.expiresAt = 0
  }
}

/** Sends a text message via the send API, used by the bot to acknowledge a command. */
export async function sendImText(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = httpFetch,
): Promise<void> {
  const response = await fetchImpl('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })
  const data = await readJson<{ code?: number; msg?: string }>(response, 'Feishu send')
  if (data.code !== 0) {
    throw new FeishuError(data.msg ?? `Feishu send failed (HTTP ${response.status})`, data.code ?? response.status)
  }
}

/**
 * Obtains a time-limited WebSocket endpoint for the long-connection mode.
 *
 * The URL already carries a one-time `token`; the returned clientId must be
 * echoed in the handshake. Token is obtained from the tenant token provider
 * rather than being accepted as a raw string, so the app secret never leaves
 * this module.
 */
export async function getWsEndpoint(
  tokenProvider: TenantTokenProvider,
  fetchImpl: typeof fetch = httpFetch,
): Promise<{ url: string; clientId: string; heartbeatSeconds: number; token: string }> {
  // parseEndpointResponse is kept in feishu-proto to avoid a cycle; import here
  // lazily to keep the modules decoupled.
  const { parseEndpointResponse } = await import('./feishu-proto')
  const token = await tokenProvider.get()
  const response = await fetchImpl(
    'https://open.feishu.cn/open-apis/callback/ws/endpoint',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  )
  const json = await readJson<unknown>(response, 'Feishu GetWsEndpoint')
  return parseEndpointResponse(json)
}

