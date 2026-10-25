import { describe, expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/lib/marketplace/github-client'
import { MarketplaceError } from '../src/lib/marketplace/types'

interface Call {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeClient(handler: (url: string, init?: RequestInit) => Response, token = 'ghp_test') {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init)
  }) as unknown as typeof fetch
  return { client: new GitHubClient({ token, fetchImpl }), calls }
}

describe('github client', () => {
  it('adds the token and API version, then parses JSON', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ login: 'octocat' }))
    await expect(client.getUser()).resolves.toEqual({ login: 'octocat' })

    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(calls[0]!.url).toBe('https://api.github.com/user')
    expect(headers.Authorization).toBe('Bearer ghp_test')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('stays anonymous when no token is configured', async () => {
    const calls: Call[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return jsonResponse({ tree: [], truncated: false })
    }) as unknown as typeof fetch
    const client = new GitHubClient({ fetchImpl })
    expect(client.authenticated).toBe(false)
    await client.listTree('dcc123456', 'BC-workflow', 'main')
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('maps auth, rate-limit, missing and conflict responses', async () => {
    await expect(
      makeClient(() => jsonResponse({ message: 'Bad credentials' }, 401)).client.getUser(),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })

    const rateLimited = makeClient(() =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
      }),
    )
    await expect(rateLimited.client.getUser()).rejects.toMatchObject({
      code: 'rate-limited',
      resetAt: 1_700_000_000_000,
    })

    await expect(
      makeClient(() => jsonResponse({ message: 'Forbidden' }, 403)).client.getUser(),
    ).rejects.toMatchObject({ code: 'forbidden' })

    await expect(
      makeClient(() => jsonResponse({ message: 'Not Found' }, 404)).client.getUser(),
    ).rejects.toMatchObject({ code: 'not-found' })

    await expect(
      makeClient(() => jsonResponse({ message: 'Validation Failed' }, 422)).client.getUser(),
    ).rejects.toMatchObject({ code: 'conflict' })

    await expect(
      makeClient(() => jsonResponse({ message: 'boom' }, 500)).client.getUser(),
    ).rejects.toMatchObject({ code: 'network', status: 500 })
  })

  it('wraps a transport failure as a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const client = new GitHubClient({ token: 'ghp_test', fetchImpl })
    await expect(client.getUser()).rejects.toBeInstanceOf(MarketplaceError)
    await expect(client.getUser()).rejects.toMatchObject({ code: 'network' })
  })

  it('writes files with encoded path segments and base64 content', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ content: {} }))
    await client.putFile('octocat', 'BC-workflow', 'workflows/a b/1.webp', {
      message: 'Add workflow',
      contentBase64: 'AAAA',
      branch: 'submit/a-1',
    })
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/octocat/BC-workflow/contents/workflows/a%20b/1.webp',
    )
    expect(calls[0]!.init!.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      message: 'Add workflow',
      content: 'AAAA',
      branch: 'submit/a-1',
    })
  })

  it('forks with the default branch only', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ full_name: 'octocat/BC-workflow' }, 202))
    await client.createFork('dcc123456', 'BC-workflow')
    expect(calls[0]!.url).toBe('https://api.github.com/repos/dcc123456/BC-workflow/forks')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ default_branch_only: true })
  })

  it('opens a PR and treats a 204 delete as success', async () => {
    const { client, calls } = makeClient((url) =>
      url.includes('/pulls')
        ? jsonResponse({ number: 7, html_url: 'https://github.com/x/y/pull/7' })
        : new Response(null, { status: 204 }),
    )
    const pull = await client.createPull('dcc123456', 'BC-workflow', {
      title: 'Add workflow: X',
      head: 'octocat:submit/x-1',
      base: 'main',
      body: 'body',
    })
    expect(pull.number).toBe(7)
    await expect(client.deleteReaction('dcc123456', 'BC-workflow', 7, 99)).resolves.toBeUndefined()
    expect(calls[1]!.init!.method).toBe('DELETE')
  })
})
