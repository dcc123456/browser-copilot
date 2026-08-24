/**
 * Minimal codecs for the Feishu (Lark) long-connection WebSocket protocol.
 *
 * The wire format is an 8-byte binary header followed by a protobuf payload.
 * We hand-roll the tiny subset of protobuf we need rather than pull in a
 * library: every field we touch is a string or an integer, and a generic
 * decoder means we never have to regenerate code when Feishu adds a field.
 *
 * Frame layout (big-endian):
 *   byte 0      protocol version, always 1
 *   byte 1      type: 1 request, 2 response, 9 ping (server→client), 10 pong
 *   byte 2      flags (bit 0 set = gzip-compressed payload)
 *   byte 3      reserved
 *   bytes 4–7   sequence id, uint32
 *   bytes 8+    protobuf payload
 *
 * The payload is a `ClientStreamRequest` (we send) or `ServerStreamResponse`
 * (we receive). The useful content lives in a string field as JSON: the
 * handshake response, or an event callback. Keeping the codec here means the
 * bot code only deals with decoded frames and parsed events.
 *
 * @module lib/feishu-proto
 */

/** Frame types defined by the protocol. */
export const FRAME = {
  REQUEST: 1,
  RESPONSE: 2,
  PING: 9,
  PONG: 10,
} as const

export const PROTOCOL_VERSION = 1

/** A decoded binary frame. */
export interface Frame {
  version: number
  type: number
  compressed: boolean
  seq: number
  /** Raw protobuf payload. */
  payload: Uint8Array
}

// --- Varint (unsigned LEB128) ------------------------------------------------

export function varintEncode(value: number): Uint8Array {
  // seq ids and string lengths are comfortably within uint32; no 64-bit care
  // needed for the values this protocol sends from a client.
  const out: number[] = []
  let v = value >>> 0
  do {
    const byte = v & 0x7f
    v >>>= 7
    out.push(v > 0 ? byte | 0x80 : byte)
  } while (v > 0)
  return new Uint8Array(out)
}

export function varintDecode(bytes: Uint8Array, start: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = start
  // Guard against a truncated stream.
  for (let guard = 0; guard < 10 && pos < bytes.length; guard += 1) {
    const byte = bytes[pos]!
    result |= (byte & 0x7f) << shift
    pos += 1
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: pos }
    shift += 7
  }
  throw new Error('truncated varint')
}

// --- Frame (de)serialization -------------------------------------------------

export function encodeFrame(type: number, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + payload.length)
  frame[0] = PROTOCOL_VERSION
  frame[1] = type
  frame[2] = 0 // no compression: we never send gzip
  frame[3] = 0
  const view = new DataView(frame.buffer)
  view.setUint32(4, seq >>> 0, false)
  frame.set(payload, 8)
  return frame
}

export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < 8) return null
  const version = bytes[0]!
  if (version !== PROTOCOL_VERSION) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = bytes[1]!
  const compressed = (bytes[2]! & 0x01) === 1
  const seq = view.getUint32(4, false)
  const payload = bytes.subarray(8)
  return { version, type, compressed, seq, payload }
}

// --- Minimal protobuf --------------------------------------------------------

/**
 * Writes a length-delimited (string/bytes) field.
 * Wire type 2: tag = (fieldNumber << 3) | 2.
 */
function writeStringField(out: number[], fieldNumber: number, value: string): void {
  const encoded = new TextEncoder().encode(value)
  out.push(...varintEncode((fieldNumber << 3) | 2))
  out.push(...varintEncode(encoded.length))
  for (const byte of encoded) out.push(byte)
}

/** Writes a varint field (wire type 0): tag = (fieldNumber << 3) | 0. */
function writeVarintField(out: number[], fieldNumber: number, value: number): void {
  out.push(...varintEncode(fieldNumber << 3))
  out.push(...varintEncode(value))
}

/**
 * Decoded fields from a protobuf message, keyed by field number.
 *
 * Strings are accumulated in order (we only need the first of each, but keeping
 * all is harmless); varint fields similarly. Anything more exotic is ignored,
 * which is exactly how protobuf is meant to evolve.
 */
export interface DecodedMessage {
  strings: Map<number, string>
  varints: Map<number, number>
}

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const strings = new Map<number, string>()
  const varints = new Map<number, number>()
  let pos = 0
  const decoder = new TextDecoder()

  while (pos < bytes.length) {
    const tag = varintDecode(bytes, pos)
    pos = tag.next
    const fieldNumber = tag.value >>> 3
    const wireType = tag.value & 0x07

    if (wireType === 0) {
      const v = varintDecode(bytes, pos)
      pos = v.next
      varints.set(fieldNumber, v.value)
    } else if (wireType === 2) {
      const len = varintDecode(bytes, pos)
      pos = len.next
      const slice = bytes.subarray(pos, pos + len.value)
      pos += len.value
      // First occurrence wins; repeated string fields are not used here.
      if (!strings.has(fieldNumber)) {
        strings.set(fieldNumber, decoder.decode(slice))
      }
    } else if (wireType === 5) {
      pos += 4 // 32-bit fixed, not used by these messages
    } else if (wireType === 1) {
      pos += 8 // 64-bit fixed, not used
    } else {
      // Unknown wire type: cannot safely continue. This should never happen with
      // Feishu's server messages, which use only strings and ints.
      break
    }
  }

  return { strings, varints }
}

// --- Handshake ---------------------------------------------------------------

/**
 * Field numbers for Feishu's `ClientStreamRequest` proto:
 *   int64 StreamSeqId = 1;
 *   string Method      = 2;
 *   string LogID       = 3;
 *   bytes  Payload     = 6;
 *   string AppId       = 8;
 *
 * We deliberately do NOT write StreamSeqId: the sequence is carried in the
 * binary frame header, and the published SDKs leave the proto field at its
 * zero value. Writing the payload to field 6 (not 8) is the fix that lets the
 * server actually parse the handshake and deliver events.
 */
const CLIENT_FIELD = {
  METHOD: 2,
  PAYLOAD: 6,
  APP_ID: 8,
} as const

/**
 * Field numbers for Feishu's `ServerStreamResponse` proto:
 *   int64  StreamSeqId = 1;
 *   uint64 Code        = 2;   // 0 on the frame carrying the response/ACK
 *   string Msg         = 3;
 *   bytes  Data        = 4;   // JSON response body or event callback
 */
const SERVER_FIELD = {
  CODE: 2,
  MSG: 3,
  DATA: 4,
} as const

export const HANDSHAKE_METHOD = 'v2:handshake'
export const EVENT_METHOD = 'v2:event'

/** Builds the JSON handshake body sent inside the request Payload field. */
export function buildHandshakePayload(input: {
  appId: string
  clientId: string
  token: string
}): string {
  return JSON.stringify({
    ClientId: input.clientId,
    AppId: input.appId,
    Token: input.token,
    DeviceId: 'browser-copilot',
    ClientVer: '0.2.0',
    Lang: 'zh_cn',
  })
}

/**
 * Encodes a client request frame.
 *
 * For events the client must ACK, use {@link encodeAck} instead.
 */
export function encodeRequest(
  seq: number,
  method: string,
  payload: string,
  appId = '',
): Uint8Array {
  const out: number[] = []
  writeStringField(out, CLIENT_FIELD.METHOD, method)
  writeStringField(out, CLIENT_FIELD.PAYLOAD, payload)
  if (appId) writeStringField(out, CLIENT_FIELD.APP_ID, appId)
  return encodeFrame(FRAME.REQUEST, seq, new Uint8Array(out))
}

/** Encodes the handshake request specifically (always carries AppId). */
export function encodeHandshake(
  seq: number,
  appId: string,
  clientId: string,
  token: string,
): Uint8Array {
  return encodeRequest(
    seq,
    HANDSHAKE_METHOD,
    buildHandshakePayload({ appId, clientId, token }),
    appId,
  )
}

/**
 * Encodes an acknowledgement for a server-sent event.
 *
 * Every event arrives as a request frame (type 1) and must be answered with a
 * response frame (type 2) carrying the same StreamSeqId and Code = 0; without
 * it Feishu considers the delivery failed and retries, eventually dropping the
 * connection. The payload is empty.
 */
export function encodeAck(seq: number): Uint8Array {
  const out: number[] = []
  writeVarintField(out, SERVER_FIELD.CODE, 0)
  return encodeFrame(FRAME.RESPONSE, seq, new Uint8Array(out))
}

/** Encodes a pong frame echoing the server's ping sequence id. */
export function encodePong(seq: number): Uint8Array {
  return encodeFrame(FRAME.PONG, seq, new Uint8Array(0))
}

/** What a decoded server frame means to the bot. */
export type ServerFrame =
  | { kind: 'handshake-ok'; seq: number; data: string }
  | { kind: 'handshake-error'; seq: number; code: number; message: string }
  | { kind: 'ping'; seq: number }
  | { kind: 'event'; seq: number; data: string }
  | { kind: 'other'; seq: number; type: number }

/** Interprets a raw frame payload. */
export function interpretFrame(frame: Frame): ServerFrame {
  if (frame.type === FRAME.PING) {
    return { kind: 'ping', seq: frame.seq }
  }

  const msg = decodeMessage(frame.payload)
  const code = msg.varints.get(SERVER_FIELD.CODE)
  const message = msg.strings.get(SERVER_FIELD.MSG) ?? ''
  const data = msg.strings.get(SERVER_FIELD.DATA) ?? ''

  if (frame.type === FRAME.RESPONSE) {
    // Code may be omitted on some response frames; treat missing as 0.
    if ((code ?? 0) === 0) return { kind: 'handshake-ok', seq: frame.seq, data }
    return { kind: 'handshake-error', seq: frame.seq, code: code ?? -1, message }
  }

  if (frame.type === FRAME.REQUEST) {
    return { kind: 'event', seq: frame.seq, data }

  }

  return { kind: 'other', seq: frame.seq, type: frame.type }
}

// --- Endpoint response -------------------------------------------------------

/** Result of calling the GetWsEndpoint HTTP API. */
export interface WsEndpoint {
  url: string
  clientId: string
  heartbeatSeconds: number
  token: string
}

/**
 * Parses the GetWsEndpoint response.
 *
 * Exported pure so the HTTP wrapper can stay thin and the shape is testable
 * against a canned response without a network mock.
 */
export function parseEndpointResponse(json: unknown): WsEndpoint {
  const root = json as {
    code?: number
    msg?: string
    data?: {
      WebSocket?: { URL?: string }
      ClientId?: string
      HeartbeatInterval?: number
      AppID?: string
    }
  }
  if (root.code !== 0) {
    throw new Error(`GetWsEndpoint failed: ${root.msg ?? `code ${root.code}`}`)
  }
  const url = root.data?.WebSocket?.URL
  const clientId = root.data?.ClientId
  if (!url || !clientId) {
    throw new Error('GetWsEndpoint response is missing WebSocket URL or ClientId.')
  }
  let token = ''
  try {
    token = new URL(url).searchParams.get('token') ?? ''
  } catch {
    token = ''
  }
  return {
    url,
    clientId,
    heartbeatSeconds: root.data?.HeartbeatInterval ?? 120,
    token,
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
