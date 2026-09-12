import { describe, it, expect, afterEach } from 'vitest'
import { verifyAppliedWorkflow } from '../src/lib/workflow/apply-verify'
import { takeoverAutoRunBudget } from '../src/lib/workflow/ai-takeover'
import type { Workflow } from '../src/lib/workflow/types'

const fakeWorkflow = { id: 'w1', name: 'w' } as unknown as Workflow

describe('verifyAppliedWorkflow (M1-10a)', () => {
  it('marks verified when the takeover-free re-run passes', async () => {
    const run = async () => ({ outcome: 'ok' as const, summary: 'done' })
    const r = await verifyAppliedWorkflow(fakeWorkflow, run)
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.summary).toBe('done')
  })

  it('marks not verified when the re-run fails at the patched node', async () => {
    const run = async () => ({ outcome: 'failed' as const, summary: 'element not found' })
    const r = await verifyAppliedWorkflow(fakeWorkflow, run)
    expect(r.ok).toBe(false)
    expect(r.verified).toBe(false)
    expect(r.summary).toBe('element not found')
  })

  it('does not swallow the injected runner error — the caller wraps it', async () => {
    const run = async () => {
      throw new Error('no live tab')
    }
    await expect(verifyAppliedWorkflow(fakeWorkflow, run)).rejects.toThrow('no live tab')
  })
})

describe('takeoverAutoRunBudget (M1-10c)', () => {
  afterEach(() => {
    delete process.env.BC_TAKEOVER_AUTORUN_BUDGET
  })

  it('defaults to 1 — a single takeover episode for automatic runs', () => {
    expect(takeoverAutoRunBudget()).toBe(1)
  })

  it('honors the BC_TAKEOVER_AUTORUN_BUDGET override', () => {
    process.env.BC_TAKEOVER_AUTORUN_BUDGET = '2'
    expect(takeoverAutoRunBudget()).toBe(2)
  })

  it('clamps non-positive and over-cap values into [1, 100]', () => {
    process.env.BC_TAKEOVER_AUTORUN_BUDGET = '0'
    expect(takeoverAutoRunBudget()).toBe(1)
    process.env.BC_TAKEOVER_AUTORUN_BUDGET = '999'
    expect(takeoverAutoRunBudget()).toBe(100)
  })
})
