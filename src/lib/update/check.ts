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
import { UpdateFailure, type UpdateCheckError, type UpdateState, type UpdateVariant } from './types'

/** Avoid hammering GitHub when several startup events fire close together. */
export const UPDATE_MIN_CHECK_INTERVAL_MS = 5 * 60_000

export interface UpdateCheckInput {
  currentVersion: string
  variant: UpdateVariant
  previous: UpdateState | null
  force: boolean
  now: number
  /** Resolves the raw `/releases/latest` JSON; throws `UpdateFailure` on transport errors. */
  fetchPayload: () => Promise<unknown>
}

export async function performUpdateCheck(input: UpdateCheckInput): Promise<UpdateState> {
  const { previous } = input
  if (
    !input.force &&
    previous &&
    !previous.error &&
    previous.currentVersion === input.currentVersion &&
    input.now - previous.checkedAt >= 0 &&
    input.now - previous.checkedAt < UPDATE_MIN_CHECK_INTERVAL_MS
  ) {
    return previous
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
    }
  } catch (error) {
    const failure = toCheckError(error)
    return {
      // Keep the last successful timestamp so the UI can say when we last
      // reached GitHub; the error explains why this attempt failed.
      checkedAt: previous?.checkedAt ?? 0,
      currentVersion: input.currentVersion,
      latest: previous?.latest ?? null,
      asset: previous?.asset ?? null,
      available: previous?.available ?? false,
      error: failure,
    }
  }
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
