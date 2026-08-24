/**
 * Minimal codecs for the Feishu (Lark) long-connection WebSocket protocol.
 *
 * After endpoint discovery, Feishu speaks a protobuf `Frame` message (namespace
 * `pbbp2` in the official SDK) over a plain binary WebSocket. Authentication is
 * carried entirely by the one-time WSS URL returned from `/callback/ws/endpoint`
 * — there is no separate in-band handshake frame. The client only sends:
 *
 *   - a **ping** control frame on a timer (the server replies with a pong whose
 *     payload carries the negotiated ping/reconnect intervals as JSON), and
 *   - an **ack** for every inbound event, echoing the frame back with a
 *     `{code:0}` JSON payload.
 *
 * The relevant subset of the protobuf schema is:
 *
 * ```proto
 * message Header { string key = 1; string value = 2; }
 * message Frame {
 *   uint64 SeqID = 1;
 *   uint64 LogID = 2;
 *   int32  service = 3;   // service id from the WSS URL query
 *   int32  method  = 4;   // 0 = control, 1 = data
 *   repeated Header headers = 5;
 *   string payloadEncoding = 6;
 *   string payloadType = 7;
 *   bytes  payload = 8;
 * }
 * ```
 *
 * We hand-roll the varint/frame codecs rather than pull in a protobuf library.
 *
 * @module lib/feishu-proto
 */

/** Frame method (protobuf `method` field): 0 = control plane, 1 = event data. */
export const METHOD = {
  CONTROL: 0,
  DATA: 1,
} as const

/** Values of the `type` header that identify control-plane frames. */
export const CTRL = {
  PING: 'ping',
  PONG: 'pong',
} as const

/** Values of the `type` header for data-plane frames. */
export const DATA = {
  EVENT: 'event',
  CARD: 'card',
} as const

/** Key/value header pair, mirroring pbbp2.Header. */
export interface FrameHeader {
  key: string
  value: string
}

/** A decoded pbbp2.Frame. */
export interface Frame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: FrameHeader[]
  payloadEncoding: string
  payloadType: string
  payload: Uint8Array
  logIdNew: string
}

// --- Varint (unsigned LEB128) ------------------------------------------------

function encodeVarint(value: bigint): Uint8Array {
  let v = value
  const out: number[] = []
  // uint64 needs at most 10 bytes.
  for (let guard = 0; guard < 10 && v >= 0x80n; guard += 1) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v & 0x7fn))
  return new Uint8Array(out)
}

function decodeVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let result = 0n
  let shift = 0n
  let pos = start
  for (let guard = 0; guard < 10 && pos < bytes.length; guard += 1) {
    const byte = bytes[pos]!
    result |= BigInt(byte & 0x7f) << shift
    pos += 1
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7n
  }
  throw new Error('truncated varint')
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function tag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType))
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  return concat([tag(fieldNumber, 2), encodeVarint(BigInt(encoded.length)), encoded])
}

function encodeBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concat([tag(fieldNumber, 2), encodeVarint(BigInt(value.length)), value])
}

function encodeVarintField(fieldNumber: number, value: bigint | number): Uint8Array {
  return concat([tag(fieldNumber, 0), encodeVarint(BigInt(value))])
}

function encodeHeader(header: FrameHeader): Uint8Array {
  // field 1 = key, field 2 = value
  return concat([encodeString(1, header.key), encodeString(2, header.value)])
}

// --- Frame (de)serialization -------------------------------------------------

/** Input shape for encoding a pbbp2.Frame. */
export interface FrameInput {
  seqId?: bigint | number
  logId?: bigint | number
  service: number
  method: number
  headers?: FrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
}

export function encodeFrame(input: FrameInput): Uint8Array {
  const parts: Uint8Array[] = [
    encodeVarintField(1, input.seqId ?? 0n),
    encodeVarintField(2, input.logId ?? 0n),
    encodeVarintField(3, input.service),
    encodeVarintField(4, input.method),
  ]
  for (const h of input.headers ?? []) {
    const encoded = encodeHeader(h)
    parts.push(tag(5, 2), encodeVarint(BigInt(encoded.length)), encoded)
  }
  if (input.payloadEncoding !== undefined) parts.push(encodeString(6, input.payloadEncoding))
  if (input.payloadType !== undefined) parts.push(encodeString(7, input.payloadType))
  if (input.payload) parts.push(encodeBytes(8, input.payload))
  return concat(parts)
}

export function decodeFrame(bytes: Uint8Array): Frame | null {
  const frame: Frame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(0),
    logIdNew: '',
  }
  let pos = 0
  try {
    while (pos < bytes.length) {
      const { value: tagValue, next } = decodeVarint(bytes, pos)
      pos = next
      const field = Number(tagValue >> 3n)
      const wireType = Number(tagValue & 7n)
      switch (field) {
        case 1: {
          const r = decodeVarint(bytes, pos)
          frame.seqId = r.value
          pos = r.next
          break
        }
        case 2: {
          const r = decodeVarint(bytes, pos)
          frame.logId = r.value
          pos = r.next
          break
        }
        case 3: {
          const r = decodeVarint(bytes, pos)
          frame.service = Number(r.value)
          pos = r.next
          break
        }
        case 4: {
          const r = decodeVarint(bytes, pos)
          frame.method = Number(r.value)
          pos = r.next
          break
        }
        case 5: {
          // nested Header message
          const lenR = decodeVarint(bytes, pos)
          const end = pos = lenR.next + Number(lenR.value)
          let key = ''
          let value = ''
          let hp = lenR.next
          while (hp < end) {
            const hr = decodeVarint(bytes, hp)
            const hField = Number(hr.value >> 3n)
            const hWire = Number(hr.value & 7n)
            hp = hr.next
            if (hWire === 2) {
              const sl = decodeVarint(bytes, hp)
              const s = bytes.slice(sl.next, sl.next + Number(sl.value))
              hp = sl.next + Number(sl.value)
              if (hField === 1) key = new TextDecoder().decode(s)
              else if (hField === 2) value = new TextDecoder().decode(s)
            } else {
              break
            }
          }
          frame.headers.push({ key, value })
          pos = end
          break
        }
        case 6: {
          const r = decodeLengthPrefixed(bytes, pos)
          frame.payloadEncoding = r.text
          pos = r.next
          break
        }
        case 7: {
          const r = decodeLengthPrefixed(bytes, pos)
          frame.payloadType = r.text
          pos = r.next
          break
        }
        case 8: {
          const r = decodeLengthPrefixed(bytes, pos)
          frame.payload = r.bytes
          pos = r.next
          break
        }
        case 9: {
          const r = decodeLengthPrefixed(bytes, pos)
          frame.logIdNew = r.text
          pos = r.next
          break
        }
        default:
          // Unknown field: skip it according to its wire type.
          if (wireType === 0) {
            const r = decodeVarint(bytes, pos)
            pos = r.next
          } else if (wireType === 2) {
            const r = decodeLengthPrefixed(bytes, pos)
            pos = r.next
          } else if (wireType === 5) {
            pos += 4
          } else if (wireType === 1) {
            pos += 8
          } else {
            return null
          }
      }
    }
  } catch {
    return null
  }
  return frame
}

function decodeLengthPrefixed(bytes: Uint8Array, pos: number): { text: string; bytes: Uint8Array; next: number } {
  const lenR = decodeVarint(bytes, pos)
  const start = lenR.next
  const end = start + Number(lenR.value)
  const slice = bytes.slice(start, end)
  return { text: new TextDecoder().decode(slice), bytes: slice, next: end }
}

// --- Convenience frame builders ---------------------------------------------

/** Builds a client→server ping control frame. */
export function encodePing(service: number): Uint8Array {
  return encodeFrame({
    service,
    method: METHOD.CONTROL,
    headers: [{ key: 'type', value: CTRL.PING }],
  })
}

/**
 * Builds the acknowledgement for an inbound event frame.
 *
 * The server requires us to echo the frame's SeqID/LogID/service/headers back
 * with a JSON payload `{"code":0}` (and optionally a base64-encoded response
 * `data`, which we leave blank for fire-and-forget events). The official SDK
 * also appends a `biz_rt` timing header; it is optional so we omit it.
 */
export function encodeAck(inbound: Frame, code = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ code }))
  return encodeFrame({
    seqId: inbound.seqId,
    logId: inbound.logId,
    service: inbound.service,
    method: inbound.method,
    headers: inbound.headers,
    payload,
  })
}

/** Returns the value of a header by key, or ''. */
export function header(frame: Frame, key: string): string {
  for (const h of frame.headers) if (h.key === key) return h.value
  return ''
}

// --- Endpoint response -------------------------------------------------------

/** Result of calling the GetWsEndpoint API. */
export interface WsEndpoint {
  url: string
  /** `service_id` query param on the URL, used as the frame service number. */
  serviceId: number
  /** `device_id` query param, echoed for logging. */
  deviceId: string
  /** Server-advertised ping interval, in seconds. */
  pingIntervalSeconds: number
}

/**
 * Parses the GetWsEndpoint response:
 * `{ code, msg, data: { URL, ClientConfig: { PingInterval, ... } } }`.
 *
 * The URL carries `service_id` and `device_id` query parameters. Exported pure
 * so the HTTP wrapper stays thin and the shape is testable without a network.
 */
export function parseEndpointResponse(json: unknown): WsEndpoint {
  const root = json as {
    code?: number
    msg?: string
    data?: {
      URL?: string
      ClientConfig?: {
        PingInterval?: number
        ReconnectCount?: number
        ReconnectInterval?: number
        ReconnectNonce?: number
      }
    }
  }
  if (root.code !== 0 || !root.data?.URL) {
    throw new Error(`GetWsEndpoint failed: ${root.msg ?? `code ${root.code}`}`)
  }
  let serviceId = 0
  let deviceId = ''
  try {
    const parsed = new URL(root.data.URL)
    serviceId = Number(parsed.searchParams.get('service_id') ?? '0')
    deviceId = parsed.searchParams.get('device_id') ?? ''
  } catch {
    // leave defaults; a malformed URL still surfaces below via serviceId=0
  }
  return {
    url: root.data.URL,
    serviceId,
    deviceId,
    pingIntervalSeconds: root.data.ClientConfig?.PingInterval ?? 90,
  }
}

// --- Event parsing -----------------------------------------------------------

/** The subset of a Feishu v2 event callback the bot cares about. */
export interface InboundMessage {
  eventType: string
  chatId: string
  /** The decoded text content of a text message. */
  text: string
  messageType: string
  messageId: string
}

/**
 * Extracts the relevant fields from an event-callback JSON string.
 *
 * Returns null for anything that is not a text message or is malformed, so the
 * caller can ignore it without a try/catch at every call site.
 */
export function parseEvent(data: string): InboundMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const v = parsed as {
    header?: { event_type?: string; event_id?: string }
    event?: {
      message?: {
        chat_id?: string
        message_type?: string
        content?: string
        message_id?: string
      }
    }
  }
  const eventType = v.header?.event_type
  const message = v.event?.message
  if (eventType !== 'im.message.receive_v1' || !message) return null
  if (message.message_type !== 'text' || !message.chat_id) return null

  let text = ''
  try {
    text = (JSON.parse(message.content ?? '{}') as { text?: string }).text ?? ''
  } catch {
    text = ''
  }

  return {
    eventType,
    chatId: message.chat_id,
    text: text.trim(),
    messageType: message.message_type,
    messageId: message.message_id ?? '',
  }
}
