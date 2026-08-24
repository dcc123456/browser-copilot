import { describe, expect, it } from 'vitest'
import {
  METHOD,
  CTRL,
  DATA,
  decodeFrame,
  encodeAck,
  encodeFrame,
  encodePing,
  header,
  parseEndpointResponse,
  parseEvent,
  type Frame,
} from '../src/lib/feishu-proto'

/** Builds a Frame for tests with sensible defaults. */
function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    seqId: 1n,
    logId: 2n,
    service: 33554678,
    method: METHOD.CONTROL,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(),
    logIdNew: '',
    ...overrides,
  }
}

describe('frame encoding/decoding', () => {
  it('round-trips a control ping with a header', () => {
    const ping = encodePing(33554678)
    const decoded = decodeFrame(ping)
    expect(decoded).not.toBeNull()
    expect(decoded!.service).toBe(33554678)
    expect(decoded!.method).toBe(METHOD.CONTROL)
    expect(header(decoded!, 'type')).toBe(CTRL.PING)
  })

  it('round-trips a data frame with headers and a payload', () => {
    const payload = new TextEncoder().encode('{"hello":1}')
    const bytes = encodeFrame({
      seqId: 42n,
      logId: 7n,
      service: 123,
      method: METHOD.DATA,
      headers: [
        { key: 'type', value: DATA.EVENT },
        { key: 'message_id', value: 'om_1' },
        { key: 'seq', value: '3' },
      ],
      payload,
    })
    const decoded = decodeFrame(bytes)!
    expect(decoded.seqId).toBe(42n)
    expect(decoded.logId).toBe(7n)
    expect(decoded.service).toBe(123)
    expect(decoded.method).toBe(METHOD.DATA)
    expect(header(decoded, 'type')).toBe(DATA.EVENT)
    expect(header(decoded, 'message_id')).toBe('om_1')
    expect(new TextDecoder().decode(decoded.payload)).toBe('{"hello":1}')
  })

  it('handles large varints (uint64 service/seq ids)', () => {
    const big = 2n ** 40n
    const bytes = encodeFrame({ seqId: big, logId: 0n, service: 1, method: METHOD.CONTROL })
    const decoded = decodeFrame(bytes)!
    expect(decoded.seqId).toBe(big)
  })

  it('returns null for a truncated varint', () => {
    // 0x80 without continuation byte -> truncated
    expect(decodeFrame(new Uint8Array([0x08, 0x80]))).toBeNull()
  })

  it('skips unknown fields', () => {
    // field 99, wire type 0 = 1
    const bytes = encodeFrame({ service: 1, method: METHOD.CONTROL, headers: [] })
    const withUnknown = new Uint8Array(bytes.length + 2)
    withUnknown.set(bytes)
    withUnknown[bytes.length] = (99 << 3) | 0
    withUnknown[bytes.length + 1] = 1
    const decoded = decodeFrame(withUnknown)
    expect(decoded).not.toBeNull()
    expect(decoded!.service).toBe(1)
  })
})

describe('ack', () => {
  it('echoes the inbound frame metadata with a {code:0} payload', () => {
    const inbound = frame({
      method: METHOD.DATA,
      headers: [{ key: 'type', value: DATA.EVENT }],
      payload: new TextEncoder().encode('event-body'),
    })
    const ack = decodeFrame(encodeAck(inbound))!
    expect(ack.seqId).toBe(inbound.seqId)
    expect(ack.logId).toBe(inbound.logId)
    expect(ack.service).toBe(inbound.service)
    expect(ack.method).toBe(METHOD.DATA)
    expect(header(ack, 'type')).toBe(DATA.EVENT)
    const body = JSON.parse(new TextDecoder().decode(ack.payload)) as { code: number }
    // The official SDK uses HttpStatusCode.ok = 200 here, not 0.
    expect(body.code).toBe(200)
  })
})

describe('parseEndpointResponse', () => {
  const url =
    'wss://msg-frontier.feishu.cn/ws/v2?fpid=493&aid=552564&device_id=7677469797122837778' +
    '&access_key=abc&service_id=33554678&ticket=xyz'

  it('extracts URL, serviceId, deviceId and ping interval', () => {
    const result = parseEndpointResponse({
      code: 0,
      data: {
        URL: url,
        ClientConfig: { PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 90, ReconnectNonce: 25 },
      },
    })
    expect(result.url).toBe(url)
    expect(result.serviceId).toBe(33554678)
    expect(result.deviceId).toBe('7677469797122837778')
    expect(result.pingIntervalSeconds).toBe(90)
  })

  it('defaults the ping interval to 90 seconds', () => {
    const result = parseEndpointResponse({ code: 0, data: { URL: url } })
    expect(result.pingIntervalSeconds).toBe(90)
  })

  it('throws on a non-zero code', () => {
    expect(() => parseEndpointResponse({ code: 999, msg: 'nope' })).toThrow(/nope/)
  })

  it('throws when the URL is missing', () => {
    expect(() => parseEndpointResponse({ code: 0, data: {} })).toThrow()
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

  it('returns null for messages sent by an app/bot (avoids reply loops)', () => {
    const event = JSON.parse(JSON.stringify(textEvent('hi'))) as {
      event: { sender?: { sender_type: string } }
    }
    event.event.sender = { sender_type: 'app' }
    expect(parseEvent(JSON.stringify(event))).toBeNull()
  })
})
