import { describe, expect, it } from 'vitest'
import {
  FRAME,
  PROTOCOL_VERSION,
  buildHandshakePayload,
  decodeFrame,
  decodeMessage,
  encodeFrame,
  encodePong,
  encodeRequest,
  interpretFrame,
  parseEndpointResponse,
  parseEvent,
  varintDecode,
  varintEncode,
} from '../src/lib/feishu-proto'

describe('varint', () => {
  it('round-trips small and large uint32 values', () => {
    for (const n of [0, 1, 127, 128, 300, 16384, 262144, 4294967295]) {
      const bytes = varintEncode(n)
      const { value, next } = varintDecode(bytes, 0)
      expect(value).toBe(n >>> 0)
      expect(next).toBe(bytes.length)
    }
  })
})

describe('frame encoding', () => {
  it('writes the 8-byte header big-endian', () => {
    const payload = new Uint8Array([1, 2, 3])
    const frame = encodeFrame(FRAME.PING, 0x01020304, payload)
    expect(frame[0]).toBe(PROTOCOL_VERSION)
    expect(frame[1]).toBe(FRAME.PING)
    expect(frame[2]).toBe(0)
    const view = new DataView(frame.buffer)
    expect(view.getUint32(4, false)).toBe(0x01020304)
    expect(Array.from(frame.slice(8))).toEqual([1, 2, 3])
  })

  it('decodes back to the same frame', () => {
    const payload = new TextEncoder().encode('hello')
    const frame = encodeFrame(FRAME.REQUEST, 42, payload)
    const decoded = decodeFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.type).toBe(FRAME.REQUEST)
    expect(decoded!.seq).toBe(42)
    expect(new TextDecoder().decode(decoded!.payload)).toBe('hello')
  })

  it('refuses a truncated frame', () => {
    expect(decodeFrame(new Uint8Array([1, 9, 0, 0]))).toBeNull()
  })

  it('refuses an unknown protocol version', () => {
    const frame = new Uint8Array(8)
    frame[0] = 9
    expect(decodeFrame(frame)).toBeNull()
  })
})

describe('protobuf decode', () => {
  it('extracts string and varint fields', () => {
    // Build a message manually: field 2 (varint) = 0, field 3 (string) = "ok"
    const parts: number[] = []
    parts.push((2 << 3) | 0, 0) // field 2 varint 0
    const s = new TextEncoder().encode('ok')
    parts.push((3 << 3) | 2, s.length, ...s)
    const msg = decodeMessage(new Uint8Array(parts))
    expect(msg.varints.get(2)).toBe(0)
    expect(msg.strings.get(3)).toBe('ok')
  })
})

describe('handshake', () => {
  it('produces a request frame with the expected JSON fields', () => {
    const body = buildHandshakePayload({
      appId: 'cli_xxx',
      clientId: 'cid-123',
      token: 'tok-abc',
    })
    const parsed = JSON.parse(body)
    expect(parsed.AppId).toBe('cli_xxx')
    expect(parsed.ClientId).toBe('cid-123')
    expect(parsed.Token).toBe('tok-abc')
  })

  it('encodes a request whose payload decodes back as JSON', () => {
    const frame = encodeRequest(1, 'v2:handshake', buildHandshakePayload({
      appId: 'a', clientId: 'c', token: 't',
    }))
    const decoded = decodeFrame(frame)!
    expect(decoded.type).toBe(FRAME.REQUEST)
    const msg = decodeMessage(decoded.payload)
    expect(msg.strings.get(2)).toBe('v2:handshake')
    const payload = JSON.parse(msg.strings.get(8)!)
    expect(payload.ClientId).toBe('c')
  })

  it('encodes a pong frame with empty payload echoing the seq', () => {
    const pong = encodePong(7)
    const decoded = decodeFrame(pong)!
    expect(decoded.type).toBe(FRAME.PONG)
    expect(decoded.seq).toBe(7)
    expect(decoded.payload.length).toBe(0)
  })
})

describe('interpretFrame', () => {
  it('recognises a ping by frame type regardless of payload', () => {
    const frame = { version: 1, type: FRAME.PING, compressed: false, seq: 5, payload: new Uint8Array() }
    const interpreted = interpretFrame(frame)
    expect(interpreted.kind).toBe('ping')
    if (interpreted.kind === 'ping') expect(interpreted.seq).toBe(5)
  })

  it('treats a response with code 0 as handshake-ok', () => {
    // field 2 varint = 0
    const payload = new Uint8Array([(2 << 3) | 0, 0])
    const frame = { version: 1, type: FRAME.RESPONSE, compressed: false, seq: 1, payload }
    expect(interpretFrame(frame).kind).toBe('handshake-ok')
  })

  it('reports a handshake error with the code and message', () => {
    // field 2 varint = 100, field 3 string = "bad"
    const s = new TextEncoder().encode('bad')
    const payload = new Uint8Array([(2 << 3) | 0, 100, (3 << 3) | 2, s.length, ...s])
    const frame = { version: 1, type: FRAME.RESPONSE, compressed: false, seq: 1, payload }
    const interpreted = interpretFrame(frame)
    expect(interpreted.kind).toBe('handshake-error')
    if (interpreted.kind === 'handshake-error') {
      expect(interpreted.code).toBe(100)
      expect(interpreted.message).toBe('bad')
    }
  })

  it('extracts event data from a request frame', () => {
    const s = new TextEncoder().encode('{"hello":1}')
    // field 4 is the Data string in ServerStreamResponse.
    const payload = new Uint8Array([(4 << 3) | 2, s.length, ...s])
    const frame = { version: 1, type: FRAME.REQUEST, compressed: false, seq: 9, payload }
    const interpreted = interpretFrame(frame)
    expect(interpreted.kind).toBe('event')
    if (interpreted.kind === 'event') expect(interpreted.data).toBe('{"hello":1}')
  })
})

describe('parseEndpointResponse', () => {
  it('extracts URL, clientId, heartbeat and token from the query', () => {
    const result = parseEndpointResponse({
      code: 0,
      data: {
        WebSocket: {
          URL: 'wss://msg-frontier.feishu.cn/ws/v2?token=abc&service=1',
        },
        ClientId: 'cid',
        HeartbeatInterval: 120,
      },
    })
    expect(result.url).toContain('wss://')
    expect(result.clientId).toBe('cid')
    expect(result.heartbeatSeconds).toBe(120)
    expect(result.token).toBe('abc')
  })

  it('throws on a non-zero code', () => {
    expect(() => parseEndpointResponse({ code: 999, msg: 'nope' })).toThrow(/nope/)
  })

  it('throws when the URL is missing', () => {
    expect(() => parseEndpointResponse({ code: 0, data: { ClientId: 'c' } })).toThrow()
  })
})

describe('parseEvent', () => {
  const textEvent = (text: string): unknown => ({
    schema: '2.0',
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

  it('extracts the text of a text message', () => {
    const parsed = parseEvent(JSON.stringify(textEvent('hello')))
    expect(parsed).toMatchObject({
      eventType: 'im.message.receive_v1',
      chatId: 'oc_1',
      text: 'hello',
      messageType: 'text',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseEvent(JSON.stringify(textEvent('  hi  ')))!.text).toBe('hi')
  })

  it('ignores non-message events', () => {
    expect(
      parseEvent(JSON.stringify({ header: { event_type: 'other' }, event: {} })),
    ).toBeNull()
  })

  it('ignores non-text messages', () => {
    const event = textEvent('x')
    ;(event as { event: { message: { message_type: string } } }).event.message.message_type = 'image'
    expect(parseEvent(JSON.stringify(event))).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseEvent('{not json')).toBeNull()
  })
})
