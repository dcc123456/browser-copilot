/**
 * Shared HTTP-request building and response decoding for the `webhook` block.
 *
 * Automa's contract (commit a4cbe34, `handlerWebhook.js` + `webhookUtil.js`)
 * lives here once so the extension and the Runner execute the same request:
 * header rows, the four content types, `$response`, `dataPath`, fallback
 * routing inputs and the "save to table" shapes.
 *
 * Chrome-free by design: `fetch`, `FormData`, `URLSearchParams` and `Blob` exist
 * in both hosts (MV3 service worker and Node 18+).
 *
 * @module lib/workflow/webhook
 */

import { getByPath } from './interpolate'

/** The form stores headers as rows; older nodes stored a JSON string. */
export interface WebhookHeaderRow {
  name: string
  value: string
}

/** Default request `content-type` per the form's "Content type" select. */
const WEBHOOK_CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  text: 'text/plain',
  'form-data': 'multipart/form-data',
  form: 'application/x-www-form-urlencoded',
}

const NO_BODY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/** A ready-to-send request, with the body already encoded for its content type. */
export interface WebhookRequestSpec {
  url: string
  method: string
  headers: Record<string, string>
  body?: BodyInit
}

/** What "Assign response to a variable" stores: the record `{{var.key}}` reads. */
export interface WebhookResponseRecord {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  data: unknown
}

/** The decoded response plus its compatibility record. */
export interface WebhookDecodedResponse {
  record: WebhookResponseRecord
  /** Value Automa assigns to `variableName` (after `dataPath` / `$response`). */
  value: unknown
}

type Interpolator = (value: string, variables: Record<string, unknown>, refData: unknown) => string

export function webhookContentTypeOf(data: Record<string, unknown>): string {
  return WEBHOOK_CONTENT_TYPES[String(data['contentType'] ?? 'json')] ?? 'application/json'
}

/** Read `{name,value}[]` rows, accepting the legacy JSON-string shape too. */
export function webhookHeaderRowsOf(value: unknown): WebhookHeaderRow[] {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`webhook: headers 不是合法 JSON，无法确定请求头：${text.slice(0, 120)}`)
    }
    return webhookHeaderRowsOf(parsed)
  }
  // Older nodes stored a plain JSON object (`{"Authorization":"…"}`), not rows.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([name, headerValue]) => ({
      name,
      value: headerValue === undefined || headerValue === null ? '' : String(headerValue),
    }))
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((row): WebhookHeaderRow[] => {
    if (!row || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    return [
      {
        name: typeof record['name'] === 'string' ? record['name'] : '',
        value: typeof record['value'] === 'string' ? record['value'] : '',
      },
    ]
  })
}

/**
 * Interpolated headers for the request. A legacy JSON object is merged as-is;
 * a row list contributes only named rows. Automa derives the content type from
 * the select rather than from headers, except for multipart, where the browser
 * must set the boundary itself.
 */
export function webhookHeadersOf(
  data: Record<string, unknown>,
  variables: Record<string, unknown>,
  refData: unknown,
  interpolate: Interpolator,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const row of webhookHeaderRowsOf(data['headers'])) {
    const name = row.name.trim()
    if (name === '') continue
    headers[name] = interpolate(row.value, variables, refData)
  }
  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  if (!hasContentType && String(data['contentType'] ?? 'json') !== 'form-data') {
    headers['Content-Type'] = webhookContentTypeOf(data)
  }
  return headers
}

/** Validate and interpolate the URL; the block never fires at a non-HTTP scheme. */
export function webhookUrlOf(
  data: Record<string, unknown>,
  variables: Record<string, unknown>,
  refData: unknown,
  interpolate: Interpolator,
): string {
  const url = interpolate(String(data['url'] ?? ''), variables, refData).trim()
  if (url === '') throw new Error('webhook: URL 不能为空')
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`webhook: URL 必须以 http:// 或 https:// 开头，收到：${url.slice(0, 120)}`)
  }
  return url
}

/** Fetch a remote/data URL into a Blob for a multipart file field. */
async function fetchBlob(path: string): Promise<Blob> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`webhook: 无法读取表单文件（HTTP ${response.status}）`)
  }
  return await response.blob()
}

/** Last path segment of a URL, without the query string. */
function fileNameOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path
  const segment = clean.split('/').pop() ?? ''
  return segment === '' ? 'file' : decodeURIComponent(segment)
}

function parsedBodyOf(
  data: Record<string, unknown>,
  interpolate: Interpolator,
  variables: Record<string, unknown>,
  refData: unknown,
): string {
  return interpolate(String(data['body'] ?? ''), variables, refData)
}

/**
 * Encode the body according to the content type:
 * - `text` stays raw;
 * - `json` must parse and is re-serialized;
 * - `form` becomes `application/x-www-form-urlencoded`;
 * - `form-data` is a 2-D array of `[name, urlOrText, filename?]` rows, where
 *   files must be http(s) URLs or data URLs (this build never reads arbitrary
 *   local paths).
 */
export async function webhookBodyOf(
  data: Record<string, unknown>,
  variables: Record<string, unknown>,
  refData: unknown,
  interpolate: Interpolator,
): Promise<BodyInit | undefined> {
  const method = String(data['method'] ?? 'POST').toUpperCase()
  if (NO_BODY_METHODS.has(method)) return undefined
  const raw = parsedBodyOf(data, interpolate, variables, refData)
  if (raw.trim() === '') return undefined

  const contentType = String(data['contentType'] ?? 'json')
  if (contentType === 'text') return raw

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`webhook: body 不是合法 JSON（contentType=${contentType}）`)
  }

  if (contentType === 'form') {
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('webhook: form body 必须是 JSON 对象或键值对数组')
    }
    return new URLSearchParams(parsed as Record<string, string>)
  }

  if (contentType === 'form-data') {
    if (!Array.isArray(parsed) || (parsed.length > 0 && !Array.isArray(parsed[0]))) {
      throw new Error('webhook: form-data body 必须是二维数组 [[name, valueOrUrl, filename?], …]')
    }
    const form = new FormData()
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 2) {
        throw new Error('webhook: form-data 的每一行至少需要 [name, value]')
      }
      const name = String(row[0] ?? '')
      const value = String(row[1] ?? '')
      const customName = typeof row[2] === 'string' && row[2] !== '' ? row[2] : ''
      const isRemote = /^(https?:\/\/|data:)/i.test(value)
      if (isRemote) {
        const blob = await fetchBlob(value)
        form.append(name, blob, customName || fileNameOf(value))
      } else if (customName !== '') {
        form.append(name, new Blob([value], { type: 'text/plain' }), customName)
      } else {
        form.append(name, value)
      }
    }
    return form
  }

  return JSON.stringify(parsed)
}

/** Build the whole request; throws for a configuration error, never for I/O. */
export async function buildWebhookRequest(
  data: Record<string, unknown>,
  variables: Record<string, unknown>,
  refData: unknown,
  interpolate: Interpolator,
): Promise<WebhookRequestSpec> {
  const method = String(data['method'] ?? 'POST').toUpperCase()
  const url = webhookUrlOf(data, variables, refData, interpolate)
  const headers = webhookHeadersOf(data, variables, refData, interpolate)
  const body = await webhookBodyOf(data, variables, refData, interpolate)
  return { url, method, headers, ...(body === undefined ? {} : { body }) }
}

/** Parse a response body according to the block's `responseType`. */
function parseResponseBody(text: string, responseType: string): unknown {
  if (responseType !== 'json') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Narrow a parsed body to the block's `dataPath` (`data.items.0.id`). */
function pickDataPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.trim() !== '')
  if (segments.length === 0) return value
  return getByPath(value, segments.join('.'))
}

/** Base64 of a response body, for `responseType: 'base64'`. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Read a fetch response the way the webhook block documents it. `base64`
 * consumes the body as bytes, every other type as text. `dataPath` narrows a
 * JSON response; when it contains `$response`, the path is resolved against
 * `{ok,url,status,statusText,redirected,data}` instead.
 */
export async function decodeWebhookResponse(
  response: Response,
  responseType: string,
  dataPath: string,
): Promise<WebhookDecodedResponse> {
  const body =
    responseType === 'base64' ? toBase64(await response.arrayBuffer()) : await response.text()
  const decoded = parseResponseBody(body, responseType)
  const includeResponse = dataPath.includes('$response')
  const value = includeResponse
    ? pickDataPath(
        {
          $response: {
            ok: response.ok,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            redirected: response.redirected,
            data: decoded,
          },
        },
        dataPath,
      )
    : responseType === 'json'
      ? pickDataPath(decoded, dataPath)
      : decoded
  return {
    record: {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      // Additive on purpose: `{{var.body}}` keeps working exactly as before.
      data: value,
    },
    value,
  }
}

/**
 * Write a webhook result to the data table like Automa's `addDataToColumn`:
 * `$assignColumns` spreads object rows, a named column appends one row per
 * array item (or one row for a scalar). Returns how many rows were appended.
 */
export function appendWebhookRows(
  variables: Record<string, unknown>,
  dataColumn: string,
  value: unknown,
): number {
  const column = dataColumn.trim()
  if (column === '') return 0
  if (!Array.isArray(variables['dataTable'])) variables['dataTable'] = []
  const table = variables['dataTable'] as Record<string, unknown>[]
  if (column === '$assignColumns') {
    const rows = Array.isArray(value) ? value : [value]
    let appended = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      table.push({ ...(row as Record<string, unknown>) })
      appended += 1
    }
    return appended
  }
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) table.push({ [column]: item })
  return values.length
}
