/**
 * The HTTP Request block honours the response fields its form exposes.
 *
 * Three of them were inert: `variableName` (the "Assign response to a variable"
 * field) while the executor read `responseVariable`, so a user- or
 * model-chosen name never existed and every downstream `{{thatName}}` dangled;
 * and `responseType` / `dataPath`, so the body was always decoded as text and
 * never narrowed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

function makeCtx(vars: Record<string, unknown> = {}, outputs?: Record<string, string>) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: vars,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
    ...(outputs ? { outputs } : {}),
  }
  return { ctx, emit }
}

/** Install a `fetch` double returning `body` with the given content type. */
function installFetch(body: string, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('webhook response handling', () => {
  it('stores the response under the name the form asked for', async () => {
    installFetch('{"ok":true}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', variableName: 'apiResult', responseType: 'json' },
      ctx,
    )
    expect(ctx.variables['apiResult']).toBeDefined()
    expect(ctx.variables['lastHttpResponse']).toBeUndefined()
  })

  it('keeps the legacy lastHttpResponse default when no name is given', async () => {
    installFetch('hello')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!({ url: 'https://api.test/x', method: 'GET' }, ctx)
    expect(ctx.variables['lastHttpResponse']).toBeDefined()
  })

  it('still honours the legacy responseVariable key', async () => {
    installFetch('hello')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', responseVariable: 'legacyName' },
      ctx,
    )
    expect(ctx.variables['legacyName']).toBeDefined()
  })

  it('parses a JSON body into `data` while keeping the raw `body`', async () => {
    installFetch('{"items":[{"id":7}]}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', variableName: 'r', responseType: 'json' },
      ctx,
    )
    const record = ctx.variables['r'] as Record<string, unknown>
    expect(record['body']).toBe('{"items":[{"id":7}]}')
    expect(record['data']).toEqual({ items: [{ id: 7 }] })
  })

  it('narrows `data` to dataPath', async () => {
    installFetch('{"items":[{"id":7},{"id":8}]}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'GET',
        variableName: 'r',
        responseType: 'json',
        dataPath: 'items.1.id',
      },
      ctx,
    )
    expect((ctx.variables['r'] as Record<string, unknown>)['data']).toBe(8)
  })

  it('leaves `data` as text when responseType is text', async () => {
    installFetch('{"items":[]}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', variableName: 'r', responseType: 'text' },
      ctx,
    )
    expect((ctx.variables['r'] as Record<string, unknown>)['data']).toBe('{"items":[]}')
  })

  it('falls back to the raw text when a JSON body will not parse', async () => {
    installFetch('not json at all')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', variableName: 'r', responseType: 'json' },
      ctx,
    )
    expect((ctx.variables['r'] as Record<string, unknown>)['data']).toBe('not json at all')
  })

  it('base64-encodes the body when responseType is base64', async () => {
    installFetch('hi')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'GET', variableName: 'r', responseType: 'base64' },
      ctx,
    )
    // "hi" in base64.
    expect((ctx.variables['r'] as Record<string, unknown>)['body']).toBe('aGk=')
  })

  it('sends the method, headers and body the node declares', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx({ token: 'T' })
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'post',
        headers: '{"Authorization":"Bearer {{token}}"}',
        body: '{"a":1}',
      },
      ctx,
    )
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://api.test/x')
    expect(call[1].method).toBe('POST')
    expect((call[1].headers as Record<string, string>)['Authorization']).toBe('Bearer T')
    expect(call[1].body).toBe('{"a":1}')
  })
})

describe('webhook request contract (Automa parity)', () => {
  it('interpolates header rows and skips unnamed ones', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx({ token: 'T' })
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'POST',
        headers: [
          { name: 'Authorization', value: 'Bearer {{token}}' },
          { name: '', value: 'ignored' },
        ],
      },
      ctx,
    )
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>)['Authorization']).toBe('Bearer T')
    expect(Object.keys(call[1].headers as Record<string, string>)).not.toContain('')
  })

  it('refuses a non-http URL before any request is made', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx()
    await expect(
      EXECUTORS['webhook']!({ url: 'ftp://api.test/x', method: 'GET' }, ctx),
    ).rejects.toThrow('http://')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GET and HEAD send no body even when one is configured', async () => {
    for (const method of ['GET', 'HEAD']) {
      const fetchMock = installFetch('{}')
      const { ctx } = makeCtx()
      await EXECUTORS['webhook']!({ url: 'https://api.test/x', method, body: '{"a":1}' }, ctx)
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(call[1].body).toBeUndefined()
    }
  })

  it('refuses a JSON body that does not parse', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx()
    await expect(
      EXECUTORS['webhook']!(
        { url: 'https://api.test/x', method: 'POST', contentType: 'json', body: '{oops' },
        ctx,
      ),
    ).rejects.toThrow('body 不是合法 JSON')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes a non-2xx response to the fallback edge when one is wired', async () => {
    installFetch('{"error":"nope"}', { ok: false, status: 422 })
    const { ctx } = makeCtx({}, { fallback: 'fb-node' })
    const next = await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'POST', body: '{}' },
      ctx,
    )
    expect(next).toBe('fb-node')
  })

  it('throws on a non-2xx response without a fallback', async () => {
    installFetch('{"error":"nope"}', { ok: false, status: 422 })
    const { ctx } = makeCtx()
    await expect(
      EXECUTORS['webhook']!({ url: 'https://api.test/x', method: 'POST', body: '{}' }, ctx),
    ).rejects.toThrow('HTTP 422')
  })

  it('routes a transport failure to the fallback edge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { ctx } = makeCtx({}, { fallback: 'fb-node' })
    const next = await EXECUTORS['webhook']!({ url: 'https://api.test/x', method: 'GET' }, ctx)
    expect(next).toBe('fb-node')
  })

  it('$response dataPath exposes status/url and assigns the narrowed value', async () => {
    installFetch('{"items":[{"id":7}]}')
    const { ctx } = makeCtx({})
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'GET',
        responseType: 'json',
        dataPath: '$response.data.items.0.id',
        assignVariable: true,
        variableName: 'firstId',
      },
      ctx,
    )
    expect(ctx.variables['firstId']).toBe(7)
  })

  it('saveData spreads $assignColumns rows into the data table', async () => {
    installFetch('[{"id":1},{"id":2}]')
    const { ctx } = makeCtx({})
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'GET',
        responseType: 'json',
        saveData: true,
        dataColumn: '$assignColumns',
      },
      ctx,
    )
    expect(ctx.variables['dataTable']).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('saveData under a named column appends one row per array item', async () => {
    installFetch('[1,2,3]')
    const { ctx } = makeCtx({})
    await EXECUTORS['webhook']!(
      {
        url: 'https://api.test/x',
        method: 'GET',
        responseType: 'json',
        saveData: true,
        dataColumn: 'score',
      },
      ctx,
    )
    expect(ctx.variables['dataTable']).toEqual([{ score: 1 }, { score: 2 }, { score: 3 }])
  })
})

describe('webhook content type', () => {
  it('uses the content type the form selected', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'POST', contentType: 'form', body: '{"a":"1"}' },
      ctx,
    )
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(String(call[1].body)).toBe('a=1')
  })

  it('defaults to JSON and lets an explicit header win', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'POST', headers: '{"content-type":"text/csv"}' },
      ctx,
    )
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>)['content-type']).toBe('text/csv')
  })
})
