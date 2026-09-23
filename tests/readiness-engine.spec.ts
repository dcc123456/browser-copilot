/**
 * Readiness engine unit tests (spec §7 Phase 4): the wait polls FRESH
 * observations until satisfied or the window expires, returns early on the
 * first fully-ready check, reports a structured READINESS_TIMEOUT with the
 * unmet state, and derives the effective spec from the node contract or the
 * block default.
 */
import { describe, expect, it } from 'vitest'
import {
  awaitReadiness,
  effectiveReadinessSpec,
  prepareNodeExecution,
  verifyPostActionReadiness,
  type ReadinessCheckResult,
} from '../src/background/workflow-engine/readiness-engine'
import type { ReadinessRequirement } from '../src/lib/workflow/readiness'
import { node } from '../specs/reliability-fixtures/harness'

const signal = new AbortController().signal
const instantSleep = async () => {}

/** A probe that satisfies only after `readyAt` observations. */
function countingProbe(
  readyAt: number,
  detail = '尚未就绪',
): { probe: (r: ReadinessRequirement) => Promise<ReadinessCheckResult>; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    probe: async () => {
      calls += 1
      return calls >= readyAt ? { satisfied: true } : { satisfied: false, detail }
    },
  }
}

const REQ: ReadinessRequirement[] = [{ state: 'present' }, { state: 'visible' }]

describe('awaitReadiness', () => {
  it('returns immediately when the first observation is satisfied', async () => {
    const { probe, calls } = countingProbe(1)
    const outcome = await awaitReadiness({
      requirements: REQ,
      nodeSelector: '#a',
      signal,
      probe,
      sleep: instantSleep,
    })
    expect(outcome).toEqual({ ok: true, waitedMs: expect.any(Number) })
    expect(calls()).toBe(2) // one per requirement, no extra polls
  })

  it('polls until ready (hit-and-return), re-observing each time', async () => {
    const { probe, calls } = countingProbe(4)
    const outcome = await awaitReadiness({
      requirements: [{ state: 'present' }],
      nodeSelector: '#a',
      signal,
      probe,
      sleep: instantSleep,
    })
    expect(outcome.ok).toBe(true)
    expect(calls()).toBe(4)
  })

  it('times out with READINESS_TIMEOUT and the unmet state', async () => {
    // NEVER satisfied: the wall-clock deadline is what must end the wait
    // (an instantSleep advances no wall time between polls).
    const { probe } = countingProbe(Number.POSITIVE_INFINITY)
    const outcome = await awaitReadiness({
      requirements: [{ state: 'visible', timeoutMs: 50 }],
      nodeSelector: '#a',
      signal,
      probe,
      sleep: instantSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('READINESS_TIMEOUT')
    expect(outcome.state).toBe('visible')
    expect(outcome.detail).toBe('尚未就绪')
  })

  it('probe failures read as not-satisfied, never abort the wait', async () => {
    let calls = 0
    const outcome = await awaitReadiness({
      requirements: [{ state: 'present', timeoutMs: 50 }],
      nodeSelector: '#a',
      signal,
      probe: async () => {
        calls += 1
        if (calls < 3) throw new Error('injection failed')
        return { satisfied: true }
      },
      sleep: instantSleep,
    })
    expect(outcome.ok).toBe(true)
  })

  it('per-requirement timeoutMs overrides the shared window', async () => {
    const { probe } = countingProbe(Number.POSITIVE_INFINITY)
    const outcome = await awaitReadiness({
      requirements: [{ state: 'present' }, { state: 'visible', timeoutMs: 30 }],
      nodeSelector: '#a',
      signal,
      probe,
      timeoutMs: 60_000,
      sleep: instantSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.state).toBe('visible')
  })

  it('respects abort: the sleep rejects and the caller sees AbortError', async () => {
    const controller = new AbortController()
    const { probe } = countingProbe(Number.POSITIVE_INFINITY)
    const wait = awaitReadiness({
      requirements: [{ state: 'present' }],
      nodeSelector: '#a',
      signal: controller.signal,
      probe,
    }) // real sleep path
    controller.abort()
    await expect(wait).rejects.toThrow()
  })
})

describe('effectiveReadinessSpec', () => {
  it('explicit __reliability.readiness wins over the block default', () => {
    const n = node('a', 'click', {
      __reliability: { readiness: { before: [{ state: 'stable' }] } },
    })
    const spec = effectiveReadinessSpec(n, 'click', {})
    expect(spec?.before?.[0]?.state).toBe('stable')
    expect(spec?.before).toHaveLength(1)
  })

  it('falls back to the block default for interaction blocks', () => {
    const n = node('a', 'click', {})
    const spec = effectiveReadinessSpec(n, 'click', {})
    expect(spec?.before?.map((r) => r.state)).toEqual(['present', 'visible', 'enabled'])
  })

  it('returns undefined for blocks without a default and without a contract', () => {
    const n = node('a', 'webhook', {})
    expect(effectiveReadinessSpec(n, 'webhook', {})).toBeUndefined()
  })
})

describe('prepareNodeExecution / verifyPostActionReadiness', () => {
  it('skips the wait when no probe is wired (runner without readiness)', async () => {
    const n = node('a', 'click', {})
    const outcome = await prepareNodeExecution({
      node: n,
      blockId: 'click',
      params: {},
      nodeSelector: '#a',
      signal,
    })
    expect(outcome).toEqual({ ok: true, waitedMs: 0 })
  })

  it('click blocks wait before via the default table', async () => {
    const n = node('a', 'click', {})
    const { probe, calls } = countingProbe(1)
    const outcome = await prepareNodeExecution({
      node: n,
      blockId: 'click',
      params: {},
      nodeSelector: '#a',
      signal,
      probe,
    })
    expect(outcome.ok).toBe(true)
    expect(calls()).toBe(3) // present + visible + enabled
  })

  it('fill blocks verify value-committed after', async () => {
    const n = node('a', 'forms', {})
    let observed: string | undefined
    const outcome = await verifyPostActionReadiness({
      node: n,
      blockId: 'forms',
      params: { action: 'fill', value: 'hello' },
      nodeSelector: '#email',
      signal,
      probe: async (requirement) => {
        observed = requirement.state
        return { satisfied: true }
      },
    })
    expect(outcome.ok).toBe(true)
    expect(observed).toBe('value-committed')
  })

  it('navigation blocks verify navigation-settled after', async () => {
    const n = node('a', 'new-tab', {})
    let failedOnce = false
    const outcome = await verifyPostActionReadiness({
      node: n,
      blockId: 'new-tab',
      params: {},
      nodeSelector: '',
      signal,
      probe: async (requirement) => {
        if (requirement.state !== 'navigation-settled') return { satisfied: true }
        if (!failedOnce) {
          failedOnce = true
          return { satisfied: false, detail: '页面尚未加载完成' }
        }
        return { satisfied: true }
      },
    })
    expect(outcome.ok).toBe(true)
  })
})
