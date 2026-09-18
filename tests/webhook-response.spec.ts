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

function makeCtx(vars: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: vars,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
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

describe('webhook content type', () => {
  it('uses the content type the form selected', async () => {
    const fetchMock = installFetch('{}')
    const { ctx } = makeCtx()
    await EXECUTORS['webhook']!(
      { url: 'https://api.test/x', method: 'POST', contentType: 'form', body: 'a=1' },
      ctx,
    )
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
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
