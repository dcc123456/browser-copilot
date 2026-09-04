import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchImageAsDataUrl } from '../src/lib/fetch-image'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function stubFetch(response: {
  ok?: boolean
  status?: number
  contentType?: string
  body?: Uint8Array
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response ? new Response(new Uint8Array(response.body ?? []), { headers: { 'content-type': response.contentType ?? '' } }) : {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        headers: { get: () => response.contentType ?? null },
        arrayBuffer: async () => (response.body ?? new Uint8Array()).buffer,
      },
    ),
  )
}

describe('fetchImageAsDataUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts PNG bytes mislabelled as text/html (jxt56 captcha server)', async () => {
    stubFetch({ contentType: 'text/html; charset=UTF-8', body: PNG_BYTES })
    const result = await fetchImageAsDataUrl('https://example.test/Api/makeVerify/x')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('accepts image content-types as before', async () => {
    stubFetch({ contentType: 'image/png', body: PNG_BYTES })
    const result = await fetchImageAsDataUrl('https://example.test/a.png')
    expect(result.ok).toBe(true)
  })

  it('rejects non-image payloads (JSON error responses)', async () => {
    stubFetch({ contentType: 'application/json', body: new Uint8Array([0x7b, 0x22, 0x63, 0x22, 0x3a, 0x31, 0x7d]) })
    const result = await fetchImageAsDataUrl('https://example.test/Api/broken')
    expect(result.ok).toBe(false)
  })
})
