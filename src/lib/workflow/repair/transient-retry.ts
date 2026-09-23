/**
 * Transient-failure bounded retry policy (spec §6.3).
 *
 * Page-not-ready / frame-not-ready / short network errors / wait conditions
 * must be given a bounded retry BEFORE the repair agent is consulted. This
 * module holds the pure policy: whether a failure qualifies, the delay
 * schedule and the attempt bookkeeping. Nothing here touches a browser or a
 * provider — callers (generation / debug orchestration) own the execution.
 *
 * When a retry succeeds the caller records `TRANSIENT_RECOVERY` telemetry and
 * produces NO patch (§6.3 end).
 *
 * @module lib/workflow/repair/transient-retry
 */

import type { RepairPolicy, VerificationFailureType } from './types'

/** Failures that default to a bounded retry instead of an immediate patch. */
export const TRANSIENT_FAILURE_TYPES: ReadonlySet<VerificationFailureType> = new Set([
  'PAGE_NOT_READY',
  'FRAME_NOT_READY',
  'NETWORK_ERROR',
  'WAIT_CONDITION_UNMET',
  // A short-lived TARGET_NOT_FOUND while the DOM/URL is still moving behaves
  // transiently; callers additionally require the stability gate below.
  'TARGET_NOT_FOUND',
  'TIMEOUT',
])

/**
 * Backoff schedule per retry attempt (ms), matching §6.3
 * `retryDelayMs: [500, 1500]`.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [500, 1500]

export interface TransientRetryPolicy {
  /** Max retry attempts before patching (§13 maxTransientRetries = 2). */
  maxRetries: number
  /** Delay before attempt N (0-based); the last value repeats after the end. */
  retryDelayMs: readonly number[]
  /** Do not patch selectors until the URL stopped changing. */
  requireStableUrlBeforeRepair: boolean
  /** Do not patch selectors until a DOM probe stopped changing. */
  requireStableDomProbeBeforeSelectorPatch: boolean
}

export const DEFAULT_TRANSIENT_POLICY: TransientRetryPolicy = {
  maxRetries: 2,
  retryDelayMs: TRANSIENT_RETRY_DELAYS_MS,
  requireStableUrlBeforeRepair: true,
  requireStableDomProbeBeforeSelectorPatch: true,
}

export interface TransientRetryState {
  /** Retries already performed. */
  retries: number
  /** The failure type under retry (kept for telemetry). */
  failureType: VerificationFailureType
}

/**
 * Whether `failureType` qualifies for a bounded retry.
 *
 * `retryable === false` on the trace failure always wins (§6.3): an
 * explicitly non-retryable signal is never retried.
 */
export function isTransientFailure(
  failureType: VerificationFailureType,
  retryable?: boolean,
): boolean {
  if (retryable === false) return false
  return TRANSIENT_FAILURE_TYPES.has(failureType)
}

/** Delay (ms) before retry attempt `attempt` (0-based). */
export function transientRetryDelayMs(policy: TransientRetryPolicy, attempt: number): number {
  const delays = policy.retryDelayMs
  if (delays.length === 0) return 0
  return delays[Math.min(attempt, delays.length - 1)] ?? 0
}

/**
 * Decide whether another bounded retry may run.
 *
 * Returns the delay to wait, or undefined when the budget is exhausted and
 * the caller must proceed to diagnosis / repair.
 */
export function nextTransientRetry(
  state: Pick<TransientRetryState, 'retries'>,
  policy: TransientRetryPolicy,
): { attempt: number; delayMs: number } | undefined {
  const maxRetries = Math.max(0, policy.maxRetries)
  if (state.retries >= maxRetries) return undefined
  return { attempt: state.retries, delayMs: transientRetryDelayMs(policy, state.retries) }
}

/** Derive the transient policy from a repair policy (shared budget source). */
export function transientPolicyOf(
  repairPolicy: RepairPolicy,
  overrides?: Partial<TransientRetryPolicy>,
): TransientRetryPolicy {
  return {
    ...DEFAULT_TRANSIENT_POLICY,
    maxRetries: repairPolicy.maxTransientRetries,
    ...overrides,
  }
}

/** Wait helper for orchestration layers; never used inside `lib` analysis. */
export function waitForTransientRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
