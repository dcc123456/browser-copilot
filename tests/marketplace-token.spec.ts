import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAuth,
  getAuth,
  isClassicToken,
  maskToken,
  setAuth,
  tokenKind,
} from '../src/lib/marketplace/token'

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

describe('marketplace token', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts classic tokens only', () => {
    expect(isClassicToken(CLASSIC)).toBe(true)
    expect(isClassicToken(FINE_GRAINED)).toBe(false)
    expect(tokenKind(FINE_GRAINED)).toBe('fine-grained')
    expect(tokenKind('nope')).toBe('unknown')
    expect(isClassicToken('ghp_short')).toBe(false)
  })

  it('stores, reads and clears the credential', async () => {
    await setAuth({ token: CLASSIC, login: 'octocat' })
    expect(await getAuth()).toEqual({ token: CLASSIC, login: 'octocat' })

    await clearAuth()
    expect(await getAuth()).toBeNull()
  })

  it('refuses to store a fine-grained token', async () => {
    await expect(setAuth({ token: FINE_GRAINED, login: 'octocat' })).rejects.toThrow(/classic/i)
    expect(mocks.store.has('marketplaceAuth')).toBe(false)
  })

  it('ignores a stored value that no longer matches the shape', async () => {
    mocks.store.set('marketplaceAuth', { token: FINE_GRAINED, login: 'octocat' })
    expect(await getAuth()).toBeNull()
    mocks.store.set('marketplaceAuth', { token: CLASSIC })
    expect(await getAuth()).toBeNull()
  })

  it('masks all but the last four characters', () => {
    expect(maskToken(CLASSIC)).toBe('••••aaaa')
  })
})
