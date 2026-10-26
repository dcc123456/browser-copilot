/**
 * Reads published files straight from `raw.githubusercontent.com`.
 *
 * The raw host serves every file with `Access-Control-Allow-Origin: *` and no
 * credential, so catalog reads cost no API quota. It caches for ~5 minutes;
 * `meta.json` opts out (see {@link fetchPublishedMeta}) because a cached 404
 * hides a workflow merged moments ago, while bundled files and screenshots
 * tolerate the delay.
 *
 * @module lib/marketplace/raw
 */

import { assetRepoPath, parseMeta, workflowDir, workflowPath } from './meta'
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

/** Returns the file text, or null when it does not exist (404). */
export async function fetchRawText(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return readRawText(rawUrl(path), fetchImpl)
}

/**
 * The published `meta.json` for a slug, or null when absent/untrustworthy.
 *
 * The raw host caches every response for five minutes, 404s included. A publish
 * reads this file on `main` just before its own merge, when the path is still
 * absent; the refresh right after the merge would otherwise be served that
 * cached 404 and the new card would not appear. GitHub ignores the query, so a
 * unique one makes each catalog read see the branch as it is now.
 */
export async function fetchPublishedMeta(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketplaceMeta | null> {
  const text = await readRawText(
    `${rawUrl(`${workflowDir(slug)}/meta.json`)}?v=${Date.now()}`,
    fetchImpl,
  )
  if (!text) return null
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return null
  }
}

/** The decoded `workflow.json`, or null when the file is missing. */
export async function fetchPublishedWorkflow(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  return fetchWorkflowAt(workflowPath(slug), fetchImpl)
}

/**
 * Decoded workflow at any repo-relative path. Bundles keep their called
 * workflows under `workflows/<slug>/deps/*.json` and `meta.json` names them.
 */
export async function fetchWorkflowAt(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  const text = await fetchRawText(path, fetchImpl)
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
export async function fetchPublishedAsset(
  slug: string,
  asset: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob | null> {
  try {
    const response = await fetchImpl(rawUrl(assetRepoPath(slug, asset)))
    return response.ok ? await response.blob() : null
  } catch {
    return null
  }
}
