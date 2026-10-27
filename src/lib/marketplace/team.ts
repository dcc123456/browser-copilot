/**
 * The team repository a user connected, and the token used to reach it.
 *
 * A team repo is an ordinary private GitHub repository whose collaborators are
 * the team: GitHub itself decides who may read and write, so the extension only
 * has to keep the coordinates and one classic PAT. The repo address is not
 * secret (it stays in `chrome.storage.local` with the other config); the token
 * is, and shares the validation and masking rules with the marketplace token.
 *
 * @module lib/marketplace/team
 */

import type { MarketplaceAuth } from './types'
import { parseRepoFullName, type RepoRef } from './repo'
import { readAuth, removeAuth, writeAuth } from './token'
/** Configuration key; also listed in `fs-store.ts`'s CONFIG_KEYS. */
export const TEAM_REPO_KEY = 'teamRepo'
export const TEAM_REPO_AUTH_KEY = 'teamRepoAuth'

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

export function teamRepoRef(config: TeamRepoConfig): RepoRef {
  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    isPrivate: true,
  }
}

/** The connected team repository, or null when none/invalid is stored. */
export async function getTeamRepo(): Promise<TeamRepoConfig | null> {
  const stored = await chrome.storage.local.get(TEAM_REPO_KEY)
  const raw = stored[TEAM_REPO_KEY]
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

export function getTeamAuth(): Promise<MarketplaceAuth | null> {
  return readAuth(TEAM_REPO_AUTH_KEY)
}

/** Stores both halves of the connection; the token is validated first. */
export async function setTeamConnection(
  config: TeamRepoConfig,
  auth: MarketplaceAuth,
): Promise<void> {
  const parsed = parseRepoFullName(`${config.owner}/${config.repo}`)
  if (!parsed || parsed.owner !== config.owner || parsed.repo !== config.repo) {
    throw new Error(`Invalid repository name: ${config.owner}/${config.repo}`)
  }
  await writeAuth(TEAM_REPO_AUTH_KEY, auth)
  await chrome.storage.local.set({
    [TEAM_REPO_KEY]: {
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      canPush: config.canPush,
      isPublic: config.isPublic,
    },
  })
}

/** Forgets the connection; installed workflows keep working. */
export async function clearTeamConnection(): Promise<void> {
  await Promise.all([removeAuth(TEAM_REPO_AUTH_KEY), chrome.storage.local.remove(TEAM_REPO_KEY)])
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
