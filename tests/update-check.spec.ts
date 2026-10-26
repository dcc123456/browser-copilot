import { describe, expect, it, vi } from 'vitest'
import {
  performUpdateCheck,
  UPDATE_MIN_CHECK_INTERVAL_MS,
  UPDATE_RETRY_BASE_MS,
  UPDATE_RETRY_MAX_MS,
  updateRetryDelayMs,
} from '../src/lib/update/check'
import { UpdateFailure, type UpdateState } from '../src/lib/update/types'
import { variantFromManifest } from '../src/lib/update/variant'

const DIGEST = `sha256:${'a'.repeat(64)}`
const TAG = 'v0.6.8'
const ASSET = `browser-copilot-0.6.8-ocr.zip`
const ASSET_URL = `https://github.com/dcc123456/browser-copilot/releases/download/${TAG}/${ASSET}`

function payload(): Record<string, unknown> {
  return {
    tag_name: TAG,
    name: TAG,
    html_url: `https://github.com/dcc123456/browser-copilot/releases/tag/${TAG}`,
    body: 'notes',
    published_at: '2026-10-20T00:00:00Z',
    assets: [{ name: ASSET, size: 100, digest: DIGEST, browser_download_url: ASSET_URL }],
  }
}

function previousState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    checkedAt: 1_000,
    currentVersion: '0.6.7',
    latest: {
      version: '0.6.8',
      tag: TAG,
      name: TAG,
      htmlUrl: `https://github.com/dcc123456/browser-copilot/releases/tag/${TAG}`,
      notes: 'notes',
      publishedAt: '2026-10-20T00:00:00Z',
    },
    asset: { name: ASSET, url: ASSET_URL, size: 100, digest: DIGEST },
    available: true,
    error: null,
    ...overrides,
  }
}

const baseInput = {
  currentVersion: '0.6.7',
  variant: 'ocr' as const,
  force: false,
  now: 2_000,
}

describe('performUpdateCheck', () => {
  it('stores the parsed release on success', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: null,
      fetchPayload: async () => payload(),
    })
    expect(state.available).toBe(true)
    expect(state.latest?.version).toBe('0.6.8')
    expect(state.asset?.name).toBe(ASSET)
    expect(state.error).toBeNull()
    expect(state.checkedAt).toBe(2_000)
  })

  it('skips a recent successful check unless forced', async () => {
    const fetchPayload = vi.fn(async () => payload())
    const previous = previousState()

    const reused = await performUpdateCheck({
      ...baseInput,
      previous,
      now: previous.checkedAt + UPDATE_MIN_CHECK_INTERVAL_MS - 1,
      fetchPayload,
    })
    expect(reused).toBe(previous)
    expect(fetchPayload).not.toHaveBeenCalled()

    await performUpdateCheck({
      ...baseInput,
      previous,
      force: true,
      now: previous.checkedAt + 1,
      fetchPayload,
    })
    expect(fetchPayload).toHaveBeenCalledTimes(1)
  })

  it('re-checks when the installed version changed', async () => {
    const fetchPayload = vi.fn(async () => payload())
    await performUpdateCheck({
      ...baseInput,
      currentVersion: '0.6.7',
      previous: previousState({ currentVersion: '0.6.6', checkedAt: 1_000 }),
      now: 1_001,
      fetchPayload,
    })
    expect(fetchPayload).toHaveBeenCalledTimes(1)
  })

  it('keeps the last successful result when a check fails', async () => {
    const previous = previousState({ checkedAt: 1_000 })
    const state = await performUpdateCheck({
      ...baseInput,
      previous,
      force: true,
      now: 9_000,
      fetchPayload: async () => {
        throw new UpdateFailure('rate-limited', 'slow down')
      },
    })
    expect(state.error).toEqual({ code: 'rate-limited', message: 'slow down' })
    expect(state.available).toBe(true)
    expect(state.latest).toEqual(previous.latest)
    expect(state.asset).toEqual(previous.asset)
    expect(state.checkedAt).toBe(previous.checkedAt)
    expect(state.failures).toBe(1)
    expect(state.retryAt).toBe(9_000 + UPDATE_RETRY_BASE_MS)
  })

  it('retries at the reset time GitHub reported', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: null,
      now: 9_000,
      fetchPayload: async () => {
        throw new UpdateFailure('rate-limited', 'slow down', 1_000_000)
      },
    })
    expect(state.retryAt).toBe(1_000_000)
  })

  it('clamps a stale reset time and caps the backoff', async () => {
    const stale = await performUpdateCheck({
      ...baseInput,
      previous: null,
      now: 9_000,
      fetchPayload: async () => {
        throw new UpdateFailure('rate-limited', 'slow down', 1_000)
      },
    })
    expect(stale.retryAt).toBe(9_000 + 30_000)

    expect(updateRetryDelayMs(1)).toBe(UPDATE_RETRY_BASE_MS)
    expect(updateRetryDelayMs(3)).toBe(60 * 60_000)
    expect(updateRetryDelayMs(20)).toBe(UPDATE_RETRY_MAX_MS)
  })

  it('does not auto-retry a failure that cannot heal', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: null,
      fetchPayload: async () => ({ tag_name: 'not-a-version' }),
    })
    expect(state.error?.code).toBe('invalid-release')
    expect(state.retryAt).toBeNull()
  })

  it('skips an automatic check until the retry is due', async () => {
    const fetchPayload = vi.fn(async () => payload())
    const previous = previousState({
      checkedAt: 1_000,
      error: { code: 'network', message: 'offline' },
      failures: 1,
      retryAt: 10_000,
    })

    const reused = await performUpdateCheck({
      ...baseInput,
      previous,
      now: 9_999,
      fetchPayload,
    })
    expect(reused).toBe(previous)
    expect(fetchPayload).not.toHaveBeenCalled()

    await performUpdateCheck({
      ...baseInput,
      previous,
      force: true,
      now: 9_999,
      fetchPayload,
    })
    expect(fetchPayload).toHaveBeenCalledTimes(1)
  })

  it('clears the failure counter after a successful check', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: previousState({
        error: { code: 'network', message: 'offline' },
        failures: 3,
        retryAt: 500_000,
      }),
      force: true,
      fetchPayload: async () => payload(),
    })
    expect(state.failures).toBe(0)
    expect(state.retryAt).toBeNull()
  })

  it('maps an unexpected failure to a network error', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: null,
      fetchPayload: async () => {
        throw new Error('offline')
      },
    })
    expect(state).toMatchObject({
      available: false,
      latest: null,
      asset: null,
      checkedAt: 0,
      error: { code: 'network', message: 'offline' },
    })
  })

  it('turns an unparsable release into an error state', async () => {
    const state = await performUpdateCheck({
      ...baseInput,
      previous: null,
      fetchPayload: async () => ({ tag_name: 'not-a-version' }),
    })
    expect(state.error?.code).toBe('invalid-release')
    expect(state.available).toBe(false)
  })
})

describe('variantFromManifest', () => {
  it('detects the no-OCR build marker', () => {
    expect(variantFromManifest({ version_name: '0.6.8 (no OCR)' })).toBe('no-ocr')
    expect(variantFromManifest({ version_name: '0.6.8' })).toBe('ocr')
    expect(variantFromManifest({})).toBe('ocr')
  })

  it('treats a Firefox manifest as firefox even with a marker', () => {
    expect(
      variantFromManifest({
        version_name: '0.6.8 (no OCR)',
        browser_specific_settings: { gecko: { id: 'x' } },
      }),
    ).toBe('firefox')
  })
})
