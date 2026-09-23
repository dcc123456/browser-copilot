import { describe, expect, it } from 'vitest'
import {
  makeRecoveryRequestRecord,
  newRecoveryRequestId,
  recoveryResponseIsCurrent,
  shouldAcceptRecoveryAction,
} from '../src/lib/workflow/recovery-protocol'

describe('workflow recovery protocol', () => {
  it('generates unique request ids', () => {
    const a = newRecoveryRequestId('wf1')
    const b = newRecoveryRequestId('wf1')
    expect(a).not.toBe(b)
    expect(a.startsWith('rec-wf1-')).toBe(true)
  })

  it('accepts the first occurrence of an action and refuses an identical repeat', () => {
    const record = makeRecoveryRequestRecord({ requestId: 'r1', workflowId: 'wf' })
    expect(shouldAcceptRecoveryAction(record, 'START')).toBe(true)
    // Double click on the same action → ignored, no second patch.
    expect(shouldAcceptRecoveryAction(record, 'START')).toBe(false)
    // A different action for the same request is still allowed.
    expect(shouldAcceptRecoveryAction(record, 'CONFIRM_REPAIR')).toBe(true)
  })

  it('drops a response whose request id does not match', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'old',
        expectedRequestId: 'current',
      }),
    ).toBe(false)
  })

  it('drops a response on an older workflow revision', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'r1',
        responseRevision: 2,
        expectedRequestId: 'r1',
        expectedRevision: 3,
      }),
    ).toBe(false)
  })

  it('keeps a response at the same revision', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'r1',
        responseRevision: 3,
        expectedRequestId: 'r1',
        expectedRevision: 3,
      }),
    ).toBe(true)
  })

  it('keeps a newer revision response', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'r1',
        responseRevision: 4,
        expectedRequestId: 'r1',
        expectedRevision: 3,
      }),
    ).toBe(true)
  })

  it('refuses a response that omits revision when the client tracks it', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'r1',
        expectedRequestId: 'r1',
        expectedRevision: 3,
      }),
    ).toBe(false)
  })

  it('accepts when neither side tracks revisions (older workflows)', () => {
    expect(
      recoveryResponseIsCurrent({
        responseRequestId: 'r1',
        expectedRequestId: 'r1',
      }),
    ).toBe(true)
  })
})
