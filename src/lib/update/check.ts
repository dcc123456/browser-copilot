/**
 * Chrome-free update-check orchestration: freshness guard, error mapping and
 * preservation of the last successful result across a failed check.
 *
 * The caller supplies the GitHub fetch, the clock and the previous state, so
 * the rules are unit-testable and the background module stays a thin shell.
 *
 * @module lib/update/check
 */

import { parseLatestRelease } from './release'
import {
  UpdateFailure,
  type UpdateCheckError,
  type UpdateCheckErrorCode,
  type UpdateState,
  type UpdateVariant,
} from './types'
import { isNewerVersion, normalizeVersion, parseSemver } from './version'

/** Avoid hammering GitHub when several startup events fire close together. */
export const UPDATE_MIN_CHECK_INTERVAL_MS = 5 * 60_000

/** First retry after a transient failure; doubles per consecutive failure. */
export const UPDATE_RETRY_BASE_MS = 15 * 60_000
/** Retries stop growing here; the 12h periodic alarm takes over. */
export const UPDATE_RETRY_MAX_MS = 6 * 60 * 60_000
const UPDATE_RETRY_FLOOR_MS = 30_000

const RETRYABLE_CODES: ReadonlySet<UpdateCheckErrorCode> = new Set(['network', 'rate-limited'])

/** Exponential backoff for the Nth consecutive transient failure (1-based). */
export function updateRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(UPDATE_RETRY_BASE_MS * 2 ** exponent, UPDATE_RETRY_MAX_MS)
}

export interface UpdateCheckInput {
  currentVersion: string
  variant: UpdateVariant
  previous: UpdateState | null
  force: boolean
  now: number
  /**
   * Resolves the latest tag from GitHub's public release redirect, which costs
   * no API quota. Omitted or rejected means "ask the API instead".
   */
  fetchLatestTag?: () => Promise<string | null>
  /** Resolves the raw `/releases/latest` JSON; throws `UpdateFailure` on transport errors. */
  fetchPayload: () => Promise<unknown>
}

export async function performUpdateCheck(input: UpdateCheckInput): Promise<UpdateState> {
  const { previous } = input
  if (!input.force && previous) {
    // A scheduled retry is a promise to the user: do not let a startup or a
    // second panel mount spend the shared IP quota before it is due.
    if (previous.error && typeof previous.retryAt === 'number' && input.now < previous.retryAt) {
      return previous
    }
    if (
      !previous.error &&
      previous.currentVersion === input.currentVersion &&
      input.now - previous.checkedAt >= 0 &&
      input.now - previous.checkedAt < UPDATE_MIN_CHECK_INTERVAL_MS
    ) {
      return previous
    }
  }

  // The quota-free probe answers the common "nothing new" case; the API is
  // only asked for asset digests and notes once a newer tag actually exists.
  if (input.fetchLatestTag && parseSemver(input.currentVersion)) {
    const latestTag = await input.fetchLatestTag().catch(() => null)
    const latestVersion = latestTag === null ? null : normalizeVersion(latestTag)
    if (
      latestVersion &&
      parseSemver(latestVersion) &&
      !isNewerVersion(latestVersion, input.currentVersion)
    ) {
      return {
        checkedAt: input.now,
        currentVersion: input.currentVersion,
        latest: null,
        asset: null,
        available: false,
        error: null,
        failures: 0,
        retryAt: null,
      }
    }
  }

  try {
    const payload = await input.fetchPayload()
    const parsed = parseLatestRelease(payload, {
      currentVersion: input.currentVersion,
      variant: input.variant,
    })
    return {
      checkedAt: input.now,
      currentVersion: input.currentVersion,
      latest: parsed.release,
      asset: parsed.asset,
      available: parsed.available,
      error: null,
      failures: 0,
      retryAt: null,
    }
  } catch (error) {
    const failure = toCheckError(error)
    const failures = (previous?.failures ?? 0) + 1
    const retryable = RETRYABLE_CODES.has(failure.code)
    const requestedAt =
      retryable && error instanceof UpdateFailure
        ? (error.retryAt ?? input.now + updateRetryDelayMs(failures))
        : null
    return {
      // Keep the last successful timestamp so the UI can say when we last
      // reached GitHub; the error explains why this attempt failed.
      checkedAt: previous?.checkedAt ?? 0,
      currentVersion: input.currentVersion,
      latest: previous?.latest ?? null,
      asset: previous?.asset ?? null,
      available: previous?.available ?? false,
      error: failure,
      failures,
      retryAt: requestedAt === null ? null : clampRetryAt(requestedAt, input.now),
    }
  }
}

/** Keep a server-provided reset inside a sane window (clock skew, bad headers). */
function clampRetryAt(candidate: number, now: number): number {
  return Math.min(Math.max(candidate, now + UPDATE_RETRY_FLOOR_MS), now + UPDATE_RETRY_MAX_MS)
}

function toCheckError(error: unknown): UpdateCheckError {
  if (error instanceof UpdateFailure) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'network',
    message: error instanceof Error ? error.message : String(error),
  }
}
