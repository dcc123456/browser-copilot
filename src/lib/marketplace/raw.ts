/**
 * Reads published files, either from the raw host or from the contents API.
 *
 * Public repositories come straight from `raw.githubusercontent.com`: it serves
 * every file with `Access-Control-Allow-Origin: *` and no credential, so catalog
 * reads cost no API quota. It caches for ~5 minutes; `meta.json` opts out (see
 * {@link fetchRepoMeta}) because a cached 404 hides a workflow merged moments
 * ago, while bundled files and screenshots tolerate the delay.
 *
 * Private repositories cannot use that host — it ignores `Authorization` — so
 * their files are read through {@link GitHubClient.getFileText}, one API call
 * per file against the authenticated quota.
 *
 * @module lib/marketplace/raw
 */

import type { GitHubClient } from './github-client'
import { assetRepoPath, parseMeta, workflowDir, workflowPath } from './meta'
import { PUBLIC_REPO, type RepoRef } from './repo'
import { MarketplaceError, type MarketplaceMeta } from './types'

/** How to read one repo: a client is required only for private content. */
export interface RepoReadAccess {
  client?: GitHubClient
  fetchImpl?: typeof fetch
}

/** Absolute raw-host URL for a repo-relative path. Public repos only. */
export function rawUrl(repo: RepoRef, path: string): string {
  const prefix = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}`
  return `${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function readRawText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new MarketplaceError(
      'network',
      `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status === 404) return null
  if (!response.ok) {
    throw new MarketplaceError('network', `GitHub returned ${response.status}`, response.status)
  }
  return response.text()
}

/**
 * The file text at a repo-relative path, or null when it does not exist.
 *
 * `bustCache` appends a unique query the raw host ignores, defeating its
 * five-minute response cache; the contents API needs no such trick.
 */
async function readRepoText(
  repo: RepoRef,
  path: string,
  access: RepoReadAccess,
  bustCache = false,
): Promise<string | null> {
  if (repo.isPrivate) {
    const client = access.client
    if (!client?.authenticated) {
      throw new MarketplaceError(
        'auth-required',
        'Reading a private repository requires a connected GitHub token',
      )
    }
    return client.getFileText(repo.owner, repo.repo, path, repo.branch)
  }
  const url = rawUrl(repo, path)
  return readRawText(bustCache ? `${url}?v=${Date.now()}` : url, access.fetchImpl ?? fetch)
}

export function fetchRepoText(
  repo: RepoRef,
  path: string,
  access: RepoReadAccess = {},
): Promise<string | null> {
  return readRepoText(repo, path, access)
}

/**
 * The published `meta.json` for a slug, or null when absent/untrustworthy.
 *
 * A publish reads this file on `main` just before its own merge, when the path
 * is still absent; the refresh right after the merge would otherwise be served
 * the raw host's cached 404 and the new card would not appear.
 */
export async function fetchRepoMeta(
  repo: RepoRef,
  slug: string,
  access: RepoReadAccess = {},
): Promise<MarketplaceMeta | null> {
  const text = await readRepoText(repo, `${workflowDir(slug)}/meta.json`, access, true)
  if (!text) return null
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return null
  }
}

/** The decoded `workflow.json`, or null when the file is missing. */
export function fetchRepoWorkflow(
  repo: RepoRef,
  slug: string,
  access: RepoReadAccess = {},
): Promise<unknown | null> {
  return fetchRepoWorkflowAt(repo, workflowPath(slug), access)
}

/**
 * Decoded workflow at any repo-relative path. Bundles keep their called
 * workflows under `workflows/<slug>/deps/*.json` and `meta.json` names them.
 */
export async function fetchRepoWorkflowAt(
  repo: RepoRef,
  path: string,
  access: RepoReadAccess = {},
): Promise<unknown | null> {
  const text = await readRepoText(repo, path, access)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new MarketplaceError('invalid', 'The published workflow file is not valid JSON')
  }
}

/**
 * One published screenshot, ready to re-upload.
 *
 * Re-editing a listing starts from what is already published, so the dialog
 * needs the stored assets as blobs. A missing asset degrades to "no image"
 * instead of failing the whole prefill.
 */
export async function fetchRepoAsset(
  repo: RepoRef,
  slug: string,
  asset: string,
  access: RepoReadAccess = {},
): Promise<Blob | null> {
  const path = assetRepoPath(slug, asset)
  if (repo.isPrivate) {
    const client = access.client
    if (!client?.authenticated) return null
    try {
      return await client.getFileBlob(repo.owner, repo.repo, path, repo.branch)
    } catch {
      return null
    }
  }
  try {
    const response = await (access.fetchImpl ?? fetch)(rawUrl(repo, path))
    return response.ok ? await response.blob() : null
  } catch {
    return null
  }
}

/** The file text on the public marketplace, or null when it does not exist. */
export function fetchRawText(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return fetchRepoText(PUBLIC_REPO, path, { fetchImpl })
}

export function fetchPublishedMeta(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketplaceMeta | null> {
  return fetchRepoMeta(PUBLIC_REPO, slug, { fetchImpl })
}

export function fetchPublishedWorkflow(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  return fetchRepoWorkflow(PUBLIC_REPO, slug, { fetchImpl })
}

export function fetchWorkflowAt(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  return fetchRepoWorkflowAt(PUBLIC_REPO, path, { fetchImpl })
}

export function fetchPublishedAsset(
  slug: string,
  asset: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob | null> {
  return fetchRepoAsset(PUBLIC_REPO, slug, asset, { fetchImpl })
}
