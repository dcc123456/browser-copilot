/**
 * Reads published files straight from `raw.githubusercontent.com`.
 *
 * The raw host serves every file with `Access-Control-Allow-Origin: *` and no
 * credential, so catalog reads cost no API quota. It caches for ~5 minutes,
 * which the publish path tolerates: a stale `meta.json` at worst proposes an
 * already-used version number, and the maintainer sees the collision in the PR.
 *
 * @module lib/marketplace/raw
 */

import { parseMeta, workflowDir } from './meta'
import {
  MARKETPLACE_BRANCH,
  MARKETPLACE_OWNER,
  MARKETPLACE_REPO,
  MarketplaceError,
  type MarketplaceMeta,
} from './types'

const RAW_BASE = `https://raw.githubusercontent.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/${MARKETPLACE_BRANCH}`

/** Absolute URL for a repo-relative path. */
export function rawUrl(path: string): string {
  return `${RAW_BASE}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Returns the file text, or null when it does not exist (404). */
export async function fetchRawText(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response
  try {
    response = await fetchImpl(rawUrl(path))
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

/** The published `meta.json` for a slug, or null when absent/untrustworthy. */
export async function fetchPublishedMeta(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketplaceMeta | null> {
  const text = await fetchRawText(`${workflowDir(slug)}/meta.json`, fetchImpl)
  if (!text) return null
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return null
  }
}
