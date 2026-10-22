/**
 * Background update checker.
 *
 * Only reads GitHub and writes the check result to `chrome.storage.local`;
 * downloading and writing the extension folder happen in the side panel,
 * where a user gesture exists (§ design). A single in-flight promise keeps
 * simultaneous startup/alarm/manual checks from issuing duplicate requests.
 *
 * @module background/update-checker
 */

import { performUpdateCheck } from '../lib/update/check'
import {
  UPDATE_CHECK_ALARM,
  UPDATE_CHECK_INTERVAL_MINUTES,
  UPDATE_LATEST_API_URL,
  UPDATE_STATE_KEY,
  UpdateFailure,
  type UpdateState,
  type UpdateVariant,
} from '../lib/update/types'
import { variantFromManifest } from '../lib/update/variant'

const FETCH_TIMEOUT_MS = 15_000

let inFlight: Promise<UpdateState> | null = null

/** The variant of the running build (ocr / no-ocr / firefox). */
export function currentUpdateVariant(): UpdateVariant {
  return variantFromManifest(chrome.runtime.getManifest())
}

/** (Re)creates the 12-hour check alarm; safe to call on every install/startup. */
export function ensureUpdateAlarm(): void {
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES })
}

/** Checks GitHub and persists the result. Concurrent callers share one request. */
export function checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateState> {
  if (inFlight) return inFlight
  inFlight = runCheck(options.force === true).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runCheck(force: boolean): Promise<UpdateState> {
  const stored = await chrome.storage.local.get(UPDATE_STATE_KEY)
  const previous = (stored[UPDATE_STATE_KEY] as UpdateState | undefined) ?? null
  const state = await performUpdateCheck({
    currentVersion: chrome.runtime.getManifest().version,
    variant: currentUpdateVariant(),
    previous,
    force,
    now: Date.now(),
    fetchPayload: fetchLatestReleasePayload,
  })
  await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state })
  return state
}

async function fetchLatestReleasePayload(): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(UPDATE_LATEST_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      signal: controller.signal,
    })
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    if (rateLimited) {
      throw new UpdateFailure('rate-limited', 'GitHub API rate limit reached; try again later.')
    }
    if (!response.ok) {
      throw new UpdateFailure('http', `GitHub returned HTTP ${response.status}.`)
    }
    try {
      return await response.json()
    } catch {
      throw new UpdateFailure('invalid-release', 'GitHub returned a non-JSON response.')
    }
  } catch (error) {
    if (error instanceof UpdateFailure) throw error
    if (controller.signal.aborted) {
      throw new UpdateFailure('network', 'GitHub did not answer within 15 seconds.')
    }
    throw new UpdateFailure('network', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}
