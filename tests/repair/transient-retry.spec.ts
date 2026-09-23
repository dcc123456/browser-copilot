/**
 * Transient-failure bounded retry policy tests (spec §6.3).
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TRANSIENT_POLICY,
  isTransientFailure,
  nextTransientRetry,
  transientPolicyOf,
  transientRetryDelayMs,
} from '../../src/lib/workflow/repair/transient-retry'
import { DEFAULT_REPAIR_POLICY } from '../../src/lib/workflow/repair/types'

describe('isTransientFailure', () => {
  it('classifies page/frame/network/wait failures as transient', () => {
    expect(isTransientFailure('PAGE_NOT_READY')).toBe(true)
    expect(isTransientFailure('FRAME_NOT_READY')).toBe(true)
    expect(isTransientFailure('NETWORK_ERROR')).toBe(true)
    expect(isTransientFailure('WAIT_CONDITION_UNMET')).toBe(true)
    expect(isTransientFailure('TARGET_NOT_FOUND')).toBe(true)
  })

  it('does not treat structural / human failures as transient', () => {
    expect(isTransientFailure('STRUCTURAL_ERROR')).toBe(false)
    expect(isTransientFailure('CAPTCHA_REQUIRED')).toBe(false)
    expect(isTransientFailure('AUTH_REQUIRED')).toBe(false)
  })

  it('respects an explicitly non-retryable signal', () => {
    expect(isTransientFailure('PAGE_NOT_READY', false)).toBe(false)
    expect(isTransientFailure('PAGE_NOT_READY', true)).toBe(true)
  })
})

describe('transient retry budget', () => {
  it('uses the [500, 1500] backoff schedule', () => {
    expect(transientRetryDelayMs(DEFAULT_TRANSIENT_POLICY, 0)).toBe(500)
    expect(transientRetryDelayMs(DEFAULT_TRANSIENT_POLICY, 1)).toBe(1500)
    // The last delay repeats past the schedule end.
    expect(transientRetryDelayMs(DEFAULT_TRANSIENT_POLICY, 4)).toBe(1500)
  })

  it('allows exactly maxRetries attempts then stops', () => {
    let state = { retries: 0 }
    const first = nextTransientRetry(state, DEFAULT_TRANSIENT_POLICY)
    expect(first?.attempt).toBe(0)
    expect(first?.delayMs).toBe(500)

    state = { retries: 1 }
    const second = nextTransientRetry(state, DEFAULT_TRANSIENT_POLICY)
    expect(second?.attempt).toBe(1)
    expect(second?.delayMs).toBe(1500)

    state = { retries: 2 }
    expect(nextTransientRetry(state, DEFAULT_TRANSIENT_POLICY)).toBeUndefined()
  })

  it('derives the policy from the shared repair policy', () => {
    const policy = transientPolicyOf({
      ...DEFAULT_REPAIR_POLICY,
      maxTransientRetries: 3,
    })
    expect(policy.maxRetries).toBe(3)
    expect(policy.requireStableUrlBeforeRepair).toBe(true)
    expect(policy.requireStableDomProbeBeforeSelectorPatch).toBe(true)
  })
})
