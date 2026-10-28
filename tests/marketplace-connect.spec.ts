import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMarketplaceToken } from '../src/lib/marketplace/connect'
import { MarketplaceError } from '../src/lib/marketplace/types'

const CLASSIC = `ghp_${'a'.repeat(36)}`
const FINE_GRAINED = `github_pat_${'b'.repeat(40)}`

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    store,
    storage: {
      local: {
        get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key)
        }),
      },
    },
  }
}

describe('connectMarketplaceToken', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects a non-classic token before touching the network', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const failure = connectMarketplaceToken(FINE_GRAINED, { fetchImpl })

    await expect(failure).rejects.toBeInstanceOf(MarketplaceError)
    await expect(failure).rejects.toMatchObject({ code: 'invalid' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(mocks.store.has('marketplaceAuth')).toBe(false)
  })

  it('resolves the account and stores the credential', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })
    }) as typeof fetch

    await expect(connectMarketplaceToken(`  ${CLASSIC}  `, { fetchImpl })).resolves.toEqual({
      token: CLASSIC,
      login: 'octocat',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/user')
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${CLASSIC}`)
    expect(mocks.store.get('marketplaceAuth')).toEqual({ token: CLASSIC, login: 'octocat' })
  })

  it('propagates a rejected token without storing it', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof fetch

    const failure = connectMarketplaceToken(CLASSIC, { fetchImpl })
    await expect(failure).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(mocks.store.has('marketplaceAuth')).toBe(false)
  })
})
