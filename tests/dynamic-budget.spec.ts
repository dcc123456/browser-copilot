import { describe, expect, it } from 'vitest'
import {
  budgetForCategory,
  decideNextBudget,
  failureSignatureOf,
  patchIsAllowed,
  startBudget,
} from '../src/lib/workflow/repair/dynamic-budget'

const failed = (signature = 'n5|TARGET_NOT_FOUND|missing') => ({
  recovered: false,
  failureSignature: signature,
})

describe('dynamic repair budget', () => {
  it('never patches a side-effect-unknown failure', () => {
    expect(patchIsAllowed('SIDE_EFFECT')).toBe(false)
    expect(budgetForCategory('SIDE_EFFECT').maxPatchRounds).toBe(0)
  })

  it('never auto-patches auth and captcha (human only)', () => {
    expect(patchIsAllowed('AUTH')).toBe(false)
    expect(patchIsAllowed('CAPTCHA')).toBe(false)
    expect(budgetForCategory('AUTH').humanOnly).toBe(true)
  })

  it('retries transient failures before any patch', () => {
    let state = startBudget('NETWORK')
    const first = decideNextBudget(state, failed('n3|NETWORK_ERROR|fetch'))
    expect(first.decision).toBe('RETRY')
    state = first.state
    const second = decideNextBudget(state, failed('n3|NETWORK_ERROR|fetch2'))
    expect(second.decision).toBe('RETRY')
  })

  it('gives locator failures a finite patch round budget', () => {
    const budget = budgetForCategory('LOCATOR')
    expect(budget.patchAllowed).toBe(true)
    expect(budget.maxPatchRounds).toBe(3)
  })

  it('does not patch data failures (provide data, not structural patch)', () => {
    expect(patchIsAllowed('DATA')).toBe(false)
  })

  it('stops early on repeated identical failures (no improvement)', () => {
    let state = startBudget('LOCATOR')
    // First failure: budget gives the single retry.
    const retry = decideNextBudget(state, failed())
    state = retry.state
    // After retry fails identically, first patch.
    const patch1 = decideNextBudget(state, failed())
    expect(patch1.decision).toBe('PATCH')
    state = patch1.state
    // Patch round 1 fails identically → patch round 2.
    const patch2 = decideNextBudget(state, failed())
    expect(patch2.decision).toBe('PATCH')
    state = patch2.state
    // Two consecutive identical post-retry signatures → no improvement stop.
    const patch3 = decideNextBudget(state, failed())
    expect(patch3.decision).toBe('STOP_NO_IMPROVEMENT')
    expect(patch3.state.exhausted).toBe(true)
  })

  it('keeps patching when the failure signature changes (improvement signal)', () => {
    let state = startBudget('LOCATOR')
    state = decideNextBudget(state, failed('n5|TARGET_NOT_FOUND|a')).state
    // retry used; first patch
    state = decideNextBudget(state, failed('n5|TARGET_NOT_FOUND|a')).state
    // signature changes: stagnant counter resets
    const next = decideNextBudget(state, failed('n5|TARGET_NOT_FOUND|b'))
    expect(next.decision).toBe('PATCH')
    expect(next.state.stagnantRounds).toBe(0)
  })

  it('exhausts the patch budget eventually', () => {
    let state = startBudget('STRUCTURAL')
    let guard = 0
    let last = decideNextBudget(state, failed(`sig-${guard}`))
    while (last.decision !== 'STOP_BUDGET_EXHAUSTED' && guard < 10) {
      state = last.state
      guard += 1
      last = decideNextBudget(state, failed(`sig-${guard}`))
    }
    expect(last.decision).toBe('STOP_BUDGET_EXHAUSTED')
  })

  it('requests human for auth after the bounded retry fails', () => {
    let state = startBudget('AUTH')
    const decision = decideNextBudget(state, failed())
    state = decision.state
    const after = decideNextBudget(state, failed())
    expect(after.decision).toBe('REQUEST_HUMAN')
  })

  it('builds stable failure signatures', () => {
    expect(
      failureSignatureOf({ failedNodeId: 'n5', code: 'TARGET_NOT_FOUND', message: 'x' }),
    ).toBe('n5|TARGET_NOT_FOUND|x')
  })
})
