/**
 * The team connection records: how several repositories coexist, what is
 * refused, how the single-connection shape migrates, and how a probe turns
 * GitHub's repository response into a record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTeamConnection,
  connectionKey,
  connectionRepo,
  getTeamAuthFor,
  getTeamConnection,
  getTeamConnections,
  resolveTeamConnection,
  setTeamConnection,
  TEAM_REPO_AUTHS_KEY,
  TEAM_REPOS_KEY,
  teamRepoRef,
  type TeamRepoConfig,
} from '../src/lib/marketplace/team'
import type { GitHubRepo } from '../src/lib/marketplace/github-client'

const CLASSIC = `ghp_${'a'.repeat(36)}`
const OTHER = `ghp_${'b'.repeat(36)}`
const OCTOCAT = { token: CLASSIC, login: 'octocat' }

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    store,
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const wanted = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        }),
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

const second = config({ owner: 'beta', repo: 'automations', branch: 'trunk' })

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
    await setTeamConnection(config(), OCTOCAT)

    expect(await getTeamConnections()).toEqual([{ config: config(), auth: OCTOCAT }])
    expect(await getTeamConnection('acme/workflows')).toEqual({ config: config(), auth: OCTOCAT })
    expect(await getTeamAuthFor('acme/workflows')).toEqual(OCTOCAT)
  })

  it('keeps one token per repository so two teams can use different accounts', async () => {
    await setTeamConnection(config(), OCTOCAT)
    await setTeamConnection(second, { token: OTHER, login: 'beta-dev' })

    expect(await getTeamConnections()).toEqual([
      { config: config(), auth: OCTOCAT },
      { config: second, auth: { token: OTHER, login: 'beta-dev' } },
    ])
    expect(await getTeamAuthFor('beta/automations')).toEqual({
      token: OTHER,
      login: 'beta-dev',
    })
    expect(await getTeamConnection('acme/workflows')).not.toBeNull()
    expect(await getTeamConnection('nobody/else')).toBeNull()
  })

  it('reconnecting the same repository replaces it instead of duplicating', async () => {
    await setTeamConnection(config(), OCTOCAT)
    const reconnected = config({ branch: 'trunk', canPush: false })
    await setTeamConnection(reconnected, { token: OTHER, login: 'octocat' })

    expect(await getTeamConnections()).toEqual([
      { config: reconnected, auth: { token: OTHER, login: 'octocat' } },
    ])
  })

  it('reads the single-connection pair written before multiple teams existed', async () => {
    mocks.store.set('teamRepo', config())
    mocks.store.set('teamRepoAuth', OCTOCAT)

    expect(await getTeamConnections()).toEqual([{ config: config(), auth: OCTOCAT }])
  })

  it('migrates the legacy pair on the first write and deletes it', async () => {
    mocks.store.set('teamRepo', config())
    mocks.store.set('teamRepoAuth', OCTOCAT)

    await setTeamConnection(second, { token: OTHER, login: 'beta-dev' })

    expect(await getTeamConnections()).toEqual([
      { config: config(), auth: OCTOCAT },
      { config: second, auth: { token: OTHER, login: 'beta-dev' } },
    ])
    expect(mocks.store.has('teamRepo')).toBe(false)
    expect(mocks.store.has('teamRepoAuth')).toBe(false)
    expect(mocks.store.has(TEAM_REPOS_KEY)).toBe(true)
    expect(mocks.store.has(TEAM_REPO_AUTHS_KEY)).toBe(true)
  })

  it('drops a repository whose token is missing or unreadable', async () => {
    await setTeamConnection(config(), OCTOCAT)
    await setTeamConnection(second, { token: OTHER, login: 'beta-dev' })
    const auths = { ...(mocks.store.get(TEAM_REPO_AUTHS_KEY) as Record<string, unknown>) }
    auths['beta/automations'] = { token: `github_pat_${'c'.repeat(40)}`, login: 'beta-dev' }
    mocks.store.set(TEAM_REPO_AUTHS_KEY, auths)

    expect(await getTeamConnections()).toEqual([{ config: config(), auth: OCTOCAT }])
  })

  it('rejects a malformed repository name before writing anything', async () => {
    await expect(setTeamConnection(config({ owner: 'not a name' }), OCTOCAT)).rejects.toThrow(
      /Invalid repository name/,
    )
    expect(mocks.store.size).toBe(0)
  })

  it('rejects a token it cannot store', async () => {
    await expect(
      setTeamConnection(config(), { token: `github_pat_${'b'.repeat(40)}`, login: 'octocat' }),
    ).rejects.toThrow(/classic/i)
    expect(mocks.store.size).toBe(0)
  })

  it('ignores a stored record that no longer matches the shape', async () => {
    mocks.store.set(TEAM_REPOS_KEY, [{ owner: 'acme', repo: 'bad name' }])
    expect(await getTeamConnections()).toEqual([])
    mocks.store.set(TEAM_REPOS_KEY, [{ owner: 42, repo: 'workflows' }])
    expect(await getTeamConnections()).toEqual([])
  })

  it('defaults the branch and permission flags for older records', async () => {
    mocks.store.set(TEAM_REPOS_KEY, [{ owner: 'acme', repo: 'workflows' }])
    mocks.store.set(TEAM_REPO_AUTHS_KEY, { 'acme/workflows': OCTOCAT })
    const [connection] = await getTeamConnections()
    expect(connection?.config).toEqual(config({ branch: 'main', canPush: true, isPublic: false }))
  })

  it('forgetting one connection leaves the others connected', async () => {
    await setTeamConnection(config(), OCTOCAT)
    await setTeamConnection(second, { token: OTHER, login: 'beta-dev' })

    await clearTeamConnection('acme/workflows')

    expect(await getTeamConnections()).toEqual([
      { config: second, auth: { token: OTHER, login: 'beta-dev' } },
    ])
    expect(await getTeamConnection('acme/workflows')).toBeNull()
  })

  it('describes each repository as private to readers', () => {
    expect(teamRepoRef(config())).toEqual({
      owner: 'acme',
      repo: 'workflows',
      branch: 'main',
      isPrivate: true,
    })
    expect(connectionRepo({ config: config(), auth: OCTOCAT })).toEqual(teamRepoRef(config()))
    expect(connectionKey({ config: config(), auth: OCTOCAT })).toBe('acme/workflows')
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
