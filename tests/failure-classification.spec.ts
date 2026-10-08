import { describe, expect, it } from 'vitest'
import {
  allowsImmediateHumanTakeover,
  classifyFailure,
  failureTypePolicy,
  fromFailureKind,
  fromVerificationFailure,
} from '../src/lib/workflow/failure-classification'

describe('failure classification', () => {
  it('recognizes element-not-found from a message', () => {
    const result = classifyFailure({ message: 'element not found: "#submit" (waited 10000ms)' })
    expect(result.type).toBe('ELEMENT_NOT_FOUND')
    expect(result.basis).toBe('message-pattern')
    expect(failureTypePolicy(result.type).humanGate).toBe(false)
  })

  it('recognizes captcha / mfa / auth as human gates', () => {
    expect(classifyFailure({ message: 'captcha challenge appeared' }).type).toBe('CAPTCHA_REQUIRED')
    expect(classifyFailure({ message: 'MFA required to continue' }).type).toBe('MFA_REQUIRED')
    expect(classifyFailure({ message: 'login required: 401' }).type).toBe('AUTH_REQUIRED')
    for (const type of ['CAPTCHA_REQUIRED', 'MFA_REQUIRED', 'AUTH_REQUIRED'] as const) {
      expect(failureTypePolicy(type).humanGate).toBe(true)
      expect(allowsImmediateHumanTakeover(type)).toBe(true)
    }
  })

  it('classifies stale / ambiguous / not visible states', () => {
    expect(classifyFailure({ message: 'stale element reference: node detached' }).type).toBe('SELECTOR_STALE')
    expect(classifyFailure({ message: 'ambiguous: 3 elements matched' }).type).toBe('ELEMENT_AMBIGUOUS')
    expect(classifyFailure({ message: 'element not visible' }).type).toBe('ELEMENT_NOT_VISIBLE')
  })

  it('routes an exhausted AI round budget into parameter repair', () => {
    // The message an `ai-agent` block now throws when its tool rounds ran out
    // before the answer round. It is a node parameter, not a mystery, so the
    // repair ladder must be allowed to propose a patch for it.
    const result = classifyFailure({
      message:
        "AI 智能体: Stopped after 2 tool rounds to avoid a loop. The turn ran out of rounds before it produced a final answer — raise the block's tool-round budget or shorten its task.",
    })
    expect(result.type).toBe('INVALID_PARAMETER')
    expect(result.basis).toBe('message-pattern')
    expect(failureTypePolicy(result.type).autoRepairable).toBe(true)
  })

  it('uses structured codes as the strongest basis', () => {
    const result = classifyFailure({
      message: 'something else',
      code: 'INPUT_REJECTED',
    })
    expect(result.type).toBe('INPUT_REJECTED')
    expect(result.basis).toBe('structured-code')
  })

  it('falls back to UNKNOWN without a human gate', () => {
    const result = classifyFailure({ message: 'a weird new error' })
    expect(result.type).toBe('UNKNOWN')
    expect(failureTypePolicy('UNKNOWN').humanGate).toBe(false)
  })

  it('maps verification codes and failure kinds', () => {
    expect(fromVerificationFailure('TARGET_NOT_FOUND')).toBe('ELEMENT_NOT_FOUND')
    expect(fromVerificationFailure('GOAL_NOT_ACHIEVED')).toBe('GOAL_NOT_SATISFIED')
    expect(fromFailureKind('locator-not-found')).toBe('ELEMENT_NOT_FOUND')
    expect(fromFailureKind('readiness')).toBe('PAGE_NOT_READY')
  })

  it('reads a missing declared input as a parameter, not as an unknown graph defect', () => {
    // Round 8: `UNRESOLVED_INPUT: {{topic}}` classified `UNKNOWN`, so the repair
    // ladder treated a value the CALLER never supplied as a locator defect and
    // spent its whole attempt budget on it. Both routes have to say the same
    // thing: the snapshot classifies from the trace's code, the trial record from
    // the message text.
    expect(fromVerificationFailure('UNRESOLVED_INPUT')).toBe('INVALID_PARAMETER')
    const result = classifyFailure({ message: 'UNRESOLVED_INPUT: {{topic}}' })
    expect(result.type).toBe('INVALID_PARAMETER')
    expect(result.basis).toBe('message-pattern')
    expect(failureTypePolicy(result.type).retryable).toBe(false)
  })

  it('classifies the page-context guard as PAGE_CONTEXT_MISMATCH', () => {
    const guardMessage =
      'WRONG_ORIGIN: 当前页面（https://creator.xiaohongshu.com）不是该工作流的目标站点（https://github.com）'
    const result = classifyFailure({ message: guardMessage })
    expect(result.type).toBe('PAGE_CONTEXT_MISMATCH')
    expect(result.basis).toBe('message-pattern')
    expect(classifyFailure({ message: 'WRONG_PAGE: 页面路径（/settings）不符合预期（/docs/*）' }).type).toBe(
      'PAGE_CONTEXT_MISMATCH',
    )
    // A structured legacy code beats message guessing.
    const structured = classifyFailure({ message: 'something else', code: 'WRONG_ORIGIN' })
    expect(structured.type).toBe('PAGE_CONTEXT_MISMATCH')
    expect(structured.basis).toBe('structured-code')
    expect(fromVerificationFailure('WRONG_PAGE')).toBe('PAGE_CONTEXT_MISMATCH')
    expect(fromFailureKind('wrong-origin')).toBe('PAGE_CONTEXT_MISMATCH')
  })

  it('treats a page-context mismatch as ordinary auto-repair, never a human gate', () => {
    const policy = failureTypePolicy('PAGE_CONTEXT_MISMATCH')
    expect(policy.autoRepairable).toBe(true)
    expect(policy.humanGate).toBe(false)
    expect(policy.unsafeToRetry).toBe(false)
    expect(allowsImmediateHumanTakeover('PAGE_CONTEXT_MISMATCH')).toBe(false)
  })
})
