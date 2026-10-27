/**
 * The team connection record: what is stored, what is refused, and how a
 * probe turns GitHub's repository response into that record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTeamConnection,
  getTeamAuth,
  getTeamRepo,
  resolveTeamConnection,
  setTeamConnection,
  TEAM_REPO_AUTH_KEY,
  TEAM_REPO_KEY,
  teamRepoRef,
  type TeamRepoConfig,
} from '../src/lib/marketplace/team'
import type { GitHubRepo } from '../src/lib/marketplace/github-client'

const CLASSIC = `ghp_${'a'.repeat(36)}`

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
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
        }),
      },
    },
  }
}

function config(overrides: Partial<TeamRepoConfig> = {}): TeamRepoConfig {
  return {
    owner: 'acme',
    repo: 'workflows',
    branch: 'main',
    canPush: true,
    isPublic: false,
    ...overrides,
  }
}

describe('team connection store', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores the address and the token together, then reads both back', async () => {
    await setTeamConnection(config(), { token: CLASSIC, login: 'octocat' })

    expect(await getTeamRepo()).toEqual(config())
    expect(await getTeamAuth()).toEqual({ token: CLASSIC, login: 'octocat' })
  })

  it('rejects a malformed repository name before writing anything', async () => {
    await expect(
      setTeamConnection(config({ owner: 'not a name' }), { token: CLASSIC, login: 'octocat' }),
    ).rejects.toThrow(/Invalid repository name/)
    expect(mocks.store.size).toBe(0)
  })

  it('rejects a token it cannot store', async () => {
    await expect(
      setTeamConnection(config(), { token: `github_pat_${'b'.repeat(40)}`, login: 'octocat' }),
    ).rejects.toThrow(/classic/i)
    expect(mocks.store.has(TEAM_REPO_KEY)).toBe(false)
  })

  it('ignores a stored record that no longer matches the shape', async () => {
    mocks.store.set(TEAM_REPO_KEY, { owner: 'acme', repo: 'bad name' })
    expect(await getTeamRepo()).toBeNull()
    mocks.store.set(TEAM_REPO_KEY, { owner: 42, repo: 'workflows' })
    expect(await getTeamRepo()).toBeNull()
    expect(await getTeamAuth()).toBeNull()
  })

  it('defaults the branch and permission flags for older records', async () => {
    mocks.store.set(TEAM_REPO_KEY, { owner: 'acme', repo: 'workflows' })
    expect(await getTeamRepo()).toEqual(config({ branch: 'main', canPush: true, isPublic: false }))
  })

  it('forgetting the connection removes both keys', async () => {
    await setTeamConnection(config(), { token: CLASSIC, login: 'octocat' })

    await clearTeamConnection()

    expect(mocks.store.has(TEAM_REPO_KEY)).toBe(false)
    expect(mocks.store.has(TEAM_REPO_AUTH_KEY)).toBe(false)
    expect(await getTeamRepo()).toBeNull()
  })

  it('describes the repository as private to readers', () => {
    expect(teamRepoRef(config())).toEqual({
      owner: 'acme',
      repo: 'workflows',
      branch: 'main',
      isPrivate: true,
    })
  })
})

describe('resolveTeamConnection', () => {
  it('takes the default branch and push permission from GitHub', async () => {
    const client = {
      getUser: async () => ({ login: 'octocat' }),
      getRepo: async (): Promise<GitHubRepo> => ({
        full_name: 'acme/workflows',
        default_branch: 'trunk',
        private: true,
        permissions: { push: true },
      }),
    }

    await expect(resolveTeamConnection(client, 'acme', 'workflows', CLASSIC)).resolves.toEqual({
      auth: { token: CLASSIC, login: 'octocat' },
      config: { owner: 'acme', repo: 'workflows', branch: 'trunk', canPush: true, isPublic: false },
    })
  })

  it('keeps a read-only member connected but unable to publish', async () => {
    const client = {
      getUser: async () => ({ login: 'reader' }),
      getRepo: async (): Promise<GitHubRepo> => ({
        full_name: 'acme/workflows',
        default_branch: 'main',
        private: true,
        permissions: { pull: true, push: false },
      }),
    }

    const { config: resolved } = await resolveTeamConnection(client, 'acme', 'workflows', CLASSIC)
    expect(resolved.canPush).toBe(false)
  })

  it('assumes push when permissions are not reported, and flags a public repo', async () => {
    const client = {
      getUser: async () => ({ login: 'octocat' }),
      getRepo: async (): Promise<GitHubRepo> => ({
        full_name: 'acme/workflows',
        default_branch: 'main',
        private: false,
      }),
    }

    const { config: resolved } = await resolveTeamConnection(client, 'acme', 'workflows', CLASSIC)
    expect(resolved.canPush).toBe(true)
    expect(resolved.isPublic).toBe(true)
  })

  it('surfaces the lookup failure instead of storing half a connection', async () => {
    const client = {
      getUser: async () => ({ login: 'octocat' }),
      getRepo: async (): Promise<GitHubRepo> => {
        throw new Error('Not Found')
      },
    }

    await expect(resolveTeamConnection(client, 'acme', 'missing', CLASSIC)).rejects.toThrow(
      'Not Found',
    )
  })
})
