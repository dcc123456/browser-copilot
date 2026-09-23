import { describe, expect, it } from 'vitest'
import {
  categoryAllowsAiPatch,
  categoryFromFailureCode,
  categoryFromVerificationFailure,
  defaultActionOf,
  defaultRecoverabilityOf,
  type WorkflowFailureCategory,
} from '../src/lib/workflow/repair/recovery-model'
import type { VerificationFailureType } from '../src/lib/workflow/repair/types'
import type { FailureCode } from '../src/lib/workflow/failure-code'

describe('recovery model category mappers', () => {
  it('maps every VerificationFailureType to a category without UNKNOWN drift', () => {
    const cases: Array<[VerificationFailureType, WorkflowFailureCategory]> = [
      ['PAGE_NOT_READY', 'TIMING'],
      ['FRAME_NOT_READY', 'TIMING'],
      ['WAIT_CONDITION_UNMET', 'TIMING'],
      ['TIMEOUT', 'TIMING'],
      ['TARGET_NOT_FOUND', 'LOCATOR'],
      ['TARGET_AMBIGUOUS', 'LOCATOR'],
      ['NETWORK_ERROR', 'NETWORK'],
      ['VARIABLE_MISSING', 'DATA'],
      ['VARIABLE_EMPTY', 'DATA'],
      ['VARIABLE_TYPE_ERROR', 'DATA'],
      ['CONTRACT_VIOLATION', 'DATA'],
      ['PRECONDITION_FAILED', 'PAGE_STATE'],
      ['POSTCONDITION_FAILED', 'SIDE_EFFECT'],
      ['GOAL_NOT_ACHIEVED', 'PAGE_STATE'],
      ['WRONG_ORIGIN', 'NAVIGATION'],
      ['WRONG_PAGE', 'NAVIGATION'],
      ['SIDE_EFFECT_UNSAFE', 'SIDE_EFFECT'],
      ['AUTH_REQUIRED', 'AUTH'],
      ['CAPTCHA_REQUIRED', 'CAPTCHA'],
      ['STRUCTURAL_ERROR', 'STRUCTURAL'],
      ['ACTION_ERROR', 'UNKNOWN'],
      ['CANCELLED', 'UNKNOWN'],
      ['UNKNOWN', 'UNKNOWN'],
    ]
    for (const [type, expected] of cases) {
      expect(categoryFromVerificationFailure(type)).toBe(expected)
    }
  })

  it('maps every FailureCode to a category', () => {
    const cases: Array<[FailureCode, WorkflowFailureCategory]> = [
      ['LOCATOR_NOT_FOUND', 'LOCATOR'],
      ['LOCATOR_AMBIGUOUS', 'LOCATOR'],
      ['ELEMENT_NOT_FOUND', 'LOCATOR'],
      ['READINESS_TIMEOUT', 'TIMING'],
      ['TIMEOUT', 'TIMING'],
      ['PRECONDITION_FAILED', 'PAGE_STATE'],
      ['POSTCONDITION_FAILED', 'SIDE_EFFECT'],
      ['GOAL_NOT_ACHIEVED', 'PAGE_STATE'],
      ['SIDE_EFFECT_UNSAFE', 'SIDE_EFFECT'],
      ['TERMINAL_STATE_UNCERTAIN', 'SIDE_EFFECT'],
      ['WRONG_ORIGIN', 'NAVIGATION'],
      ['WRONG_PAGE', 'NAVIGATION'],
      ['VALIDATION_FAILED', 'STRUCTURAL'],
      ['ABORTED', 'UNKNOWN'],
      ['UNKNOWN', 'UNKNOWN'],
    ]
    for (const [code, expected] of cases) {
      expect(categoryFromFailureCode(code)).toBe(expected)
    }
  })

  it('falls back to UNKNOWN for undefined inputs', () => {
    expect(categoryFromVerificationFailure(undefined)).toBe('UNKNOWN')
    expect(categoryFromFailureCode(undefined)).toBe('UNKNOWN')
  })

  it('enforces safety recoverability: side-effect BLOCKED, auth/captcha HUMAN', () => {
    expect(defaultRecoverabilityOf('SIDE_EFFECT')).toBe('BLOCKED')
    expect(defaultRecoverabilityOf('AUTH')).toBe('HUMAN')
    expect(defaultRecoverabilityOf('CAPTCHA')).toBe('HUMAN')
  })

  it('keeps timing/network auto-recoverable and locator/data as suggest', () => {
    expect(defaultRecoverabilityOf('TIMING')).toBe('AUTO')
    expect(defaultRecoverabilityOf('NETWORK')).toBe('AUTO')
    expect(defaultRecoverabilityOf('LOCATOR')).toBe('SUGGEST')
    expect(defaultRecoverabilityOf('DATA')).toBe('SUGGEST')
  })

  it('provides a default action per category', () => {
    expect(defaultActionOf('TIMING')).toBe('RETRY')
    expect(defaultActionOf('LOCATOR')).toBe('PATCH_LOCATOR')
    expect(defaultActionOf('AUTH')).toBe('REQUEST_LOGIN')
    expect(defaultActionOf('CAPTCHA')).toBe('REQUEST_CAPTCHA')
    expect(defaultActionOf('SIDE_EFFECT')).toBe('BLOCK_SIDE_EFFECT')
  })

  it('never allows an AI patch for auth/captcha/side-effect', () => {
    expect(categoryAllowsAiPatch('AUTH')).toBe(false)
    expect(categoryAllowsAiPatch('CAPTCHA')).toBe(false)
    expect(categoryAllowsAiPatch('SIDE_EFFECT')).toBe(false)
    expect(categoryAllowsAiPatch('LOCATOR')).toBe(true)
  })
})
