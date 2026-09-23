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
})
