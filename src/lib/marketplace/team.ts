/**
 * The team repositories a user connected, and the token used to reach each.
 *
 * A team repo is an ordinary private GitHub repository whose collaborators are
 * the team: GitHub itself decides who may read and write, so the extension only
 * has to keep the coordinates and one classic PAT per connection. Someone can
 * belong to several teams (often under different GitHub accounts), so each
 * repository carries its own token. The repo addresses are not secret (they
 * stay in `chrome.storage.local` with the other config); the tokens are, and
 * share the validation and masking rules with the marketplace token.
 *
 * @module lib/marketplace/team
 */

import type { MarketplaceAuth } from './types'
import { parseRepoFullName, type RepoRef } from './repo'
import { isClassicToken } from './token'

/** Configuration keys; also listed in `fs-store.ts`'s CONFIG_KEYS. */
export const TEAM_REPOS_KEY = 'teamRepos'
export const TEAM_REPO_AUTHS_KEY = 'teamRepoAuths'

/** The single-connection keys written before multiple teams were supported. */
const LEGACY_REPO_KEY = 'teamRepo'
const LEGACY_AUTH_KEY = 'teamRepoAuth'

export interface TeamRepoConfig {
  owner: string
  repo: string
  /** Default branch captured at connect time; both reads and PRs target it. */
  branch: string
  /**
   * False when the token can read but not push. Browsing and applying still
   * work; publishing is blocked with an explanation instead of a 403 later.
   */
  canPush: boolean
  /**
   * GitHub reports the repository as public. Reads still take the authenticated
   * path (a team token always talks to the API), but the panel keeps warning
   * that anything shared there is readable by every GitHub user.
   */
  isPublic: boolean
}

/** One connected repository together with the token that reaches it. */
export interface TeamConnection {
  config: TeamRepoConfig
  auth: MarketplaceAuth
}

export function teamRepoRef(config: TeamRepoConfig): RepoRef {
  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    isPrivate: true,
  }
}

/** `owner/repo` — the identity of one connection in storage and in the UI. */
export function teamConnKey(config: Pick<TeamRepoConfig, 'owner' | 'repo'>): string {
  return `${config.owner}/${config.repo}`
}

export function connectionRepo(connection: TeamConnection): RepoRef {
  return teamRepoRef(connection.config)
}

export function connectionKey(connection: TeamConnection): string {
  return teamConnKey(connection.config)
}

function parseConfig(raw: unknown): TeamRepoConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const { owner, repo, branch, canPush, isPublic } = raw as Partial<TeamRepoConfig>
  if (typeof owner !== 'string' || typeof repo !== 'string') return null
  const parsed = parseRepoFullName(`${owner}/${repo}`)
  if (!parsed || parsed.owner !== owner || parsed.repo !== repo) return null
  return {
    owner,
    repo,
    branch: typeof branch === 'string' && branch ? branch : 'main',
    // Records written before the permission probe existed assume push.
    canPush: canPush !== false,
    isPublic: isPublic === true,
  }
}

function parseConfigs(raw: unknown): TeamRepoConfig[] {
  if (!Array.isArray(raw)) return []
  const configs: TeamRepoConfig[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const config = parseConfig(item)
    if (!config) continue
    const key = teamConnKey(config)
    if (seen.has(key)) continue
    seen.add(key)
    configs.push(config)
  }
  return configs
}

function parseAuth(raw: unknown): MarketplaceAuth | null {
  if (!raw || typeof raw !== 'object') return null
  const { token, login } = raw as Partial<MarketplaceAuth>
  if (typeof token !== 'string' || !isClassicToken(token)) return null
  if (typeof login !== 'string' || !login || login.length > 64) return null
  return { token, login }
}

/** Tokens keyed by repository; a malformed record is simply not offered. */
function parseAuths(raw: unknown): Record<string, MarketplaceAuth> {
  if (!raw || typeof raw !== 'object') return {}
  const auths: Record<string, MarketplaceAuth> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const auth = parseAuth(value)
    if (auth && parseRepoFullName(key)) auths[key] = auth
  }
  return auths
}

interface StoredConnections {
  configs: TeamRepoConfig[]
  auths: Record<string, MarketplaceAuth>
}

/**
 * Reads both halves of every connection.
 *
 * The legacy single-connection pair is only consulted while the list is empty,
 * so a user who connected a team before this version keeps their repository
 * without doing anything. The next write migrates it.
 */
async function readStored(): Promise<StoredConnections> {
  const stored = await chrome.storage.local.get([
    TEAM_REPOS_KEY,
    TEAM_REPO_AUTHS_KEY,
    LEGACY_REPO_KEY,
    LEGACY_AUTH_KEY,
  ])
  const configs = parseConfigs(stored[TEAM_REPOS_KEY])
  if (configs.length > 0) {
    return { configs, auths: parseAuths(stored[TEAM_REPO_AUTHS_KEY]) }
  }
  const legacy = parseConfig(stored[LEGACY_REPO_KEY])
  if (!legacy) return { configs: [], auths: {} }
  const legacyAuth = parseAuth(stored[LEGACY_AUTH_KEY])
  return {
    configs: [legacy],
    auths: legacyAuth ? { [teamConnKey(legacy)]: legacyAuth } : {},
  }
}

/** Every complete connection: a repository and a readable token for it. */
export async function getTeamConnections(): Promise<TeamConnection[]> {
  const { configs, auths } = await readStored()
  const connections: TeamConnection[] = []
  for (const config of configs) {
    const auth = auths[teamConnKey(config)]
    if (auth) connections.push({ config, auth })
  }
  return connections
}

/** The connection for `owner/repo`, or null when that repo is not connected. */
export async function getTeamConnection(repoFullName: string): Promise<TeamConnection | null> {
  const normalized = parseRepoFullName(repoFullName)
  if (!normalized) return null
  const connections = await getTeamConnections()
  return connections.find((entry) => connectionKey(entry) === teamConnKey(normalized)) ?? null
}

/** Token for one repository; null when it is not connected. */
export async function getTeamAuthFor(repoFullName: string): Promise<MarketplaceAuth | null> {
  return (await getTeamConnection(repoFullName))?.auth ?? null
}

/**
 * Stores both halves of one connection, replacing any earlier record for the
 * same repository. The legacy single-connection keys are folded in here and
 * then removed, so the read path never has to merge two shapes.
 */
export async function setTeamConnection(
  config: TeamRepoConfig,
  auth: MarketplaceAuth,
): Promise<void> {
  const parsed = parseRepoFullName(`${config.owner}/${config.repo}`)
  if (!parsed || parsed.owner !== config.owner || parsed.repo !== config.repo) {
    throw new Error(`Invalid repository name: ${config.owner}/${config.repo}`)
  }
  if (!isClassicToken(auth.token)) {
    throw new Error('A team connection needs a classic personal access token')
  }
  const { configs, auths } = await readStored()
  const key = teamConnKey(config)
  const nextConfigs = configs.filter((entry) => teamConnKey(entry) !== key)
  nextConfigs.push(config)
  const nextAuths: Record<string, MarketplaceAuth> = { ...auths, [key]: auth }
  await chrome.storage.local.set({
    [TEAM_REPOS_KEY]: nextConfigs,
    [TEAM_REPO_AUTHS_KEY]: nextAuths,
  })
  await chrome.storage.local.remove([LEGACY_REPO_KEY, LEGACY_AUTH_KEY])
}

/** Forgets one connection; installed workflows keep working. */
export async function clearTeamConnection(repoFullName: string): Promise<void> {
  const parsed = parseRepoFullName(repoFullName)
  if (!parsed) return
  const key = teamConnKey(parsed)
  const { configs, auths } = await readStored()
  const nextAuths: Record<string, MarketplaceAuth> = { ...auths }
  delete nextAuths[key]
  await chrome.storage.local.set({
    [TEAM_REPOS_KEY]: configs.filter((entry) => teamConnKey(entry) !== key),
    [TEAM_REPO_AUTHS_KEY]: nextAuths,
  })
  await chrome.storage.local.remove([LEGACY_REPO_KEY, LEGACY_AUTH_KEY])
}

/** The slice of {@link GitHubClient} a connection probe needs. */
export interface TeamProbeClient {
  getUser(): Promise<{ login: string }>
  getRepo(
    owner: string,
    repo: string,
  ): Promise<{
    default_branch?: string
    private?: boolean
    permissions?: { push?: boolean }
  }>
}

/**
 * Turns an address and a token into the record stored by {@link setTeamConnection}.
 *
 * `GET /user` proves the token works and names the account; `GET /repos/…`
 * proves the token can see the repository and reports the default branch and
 * whether it may push. A 404 from the second call is ambiguous on GitHub (repo
 * missing or no access), which is exactly the copy the caller shows.
 */
export async function resolveTeamConnection(
  client: TeamProbeClient,
  owner: string,
  repo: string,
  token: string,
): Promise<{ config: TeamRepoConfig; auth: MarketplaceAuth }> {
  const [me, info] = await Promise.all([client.getUser(), client.getRepo(owner, repo)])
  return {
    auth: { token, login: me.login },
    config: {
      owner,
      repo,
      branch: info.default_branch || 'main',
      canPush: info.permissions?.push !== false,
      isPublic: info.private !== true,
    },
  }
}
