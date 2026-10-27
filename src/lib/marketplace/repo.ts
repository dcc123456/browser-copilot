/**
 * Which GitHub repository a catalog read or publish talks to.
 *
 * The public marketplace and a team's private repository share every code path;
 * only the repository coordinates and the file-read transport differ. Private
 * repositories cannot be read from `raw.githubusercontent.com` (that host takes
 * no Authorization header), so reads for them go through the REST contents API
 * with the user's token.
 *
 * @module lib/marketplace/repo
 */

import { MARKETPLACE_BRANCH, MARKETPLACE_OWNER, MARKETPLACE_REPO } from './types'

export interface RepoRef {
  owner: string
  repo: string
  /** Branch both reads and pull requests target. */
  branch: string
  /** Private repositories are read through the authenticated contents API. */
  isPrivate: boolean
}

/** The public marketplace every install can read anonymously. */
export const PUBLIC_REPO: RepoRef = {
  owner: MARKETPLACE_OWNER,
  repo: MARKETPLACE_REPO,
  branch: MARKETPLACE_BRANCH,
  isPrivate: false,
}

export function repoFullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

/** Splits `owner/repo` typed into settings; null when either half is invalid. */
export function parseRepoFullName(input: string): { owner: string; repo: string } | null {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts as [string, string]
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null
  if (repo === '.' || repo === '..') return null
  return { owner, repo }
}
