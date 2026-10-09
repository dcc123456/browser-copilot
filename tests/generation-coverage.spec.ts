import { describe, expect, it } from 'vitest'
import {
  coverageWarningLines,
  failedBlockIdsOf,
  forgetCoverage,
  isRecordOnlyBlock,
  markOperatorFailure,
  markOperatorRecovery,
} from '../src/lib/workflow/generation-coverage'

describe('generation coverage tracking', () => {
  it('records failures and clears them only on a successful retry', () => {
    forgetCoverage('c1')
    markOperatorFailure('c1', 'event-click')
    markOperatorFailure('c1', 'press-key')
    expect(failedBlockIdsOf('c1')).toEqual(['event-click', 'press-key'])

    markOperatorRecovery('c1', 'event-click')
    expect(failedBlockIdsOf('c1')).toEqual(['press-key'])

    forgetCoverage('c1')
    expect(failedBlockIdsOf('c1')).toEqual([])
  })

  it('classifies only-record blocks', () => {
    expect(isRecordOnlyBlock('event-click')).toBe(false)
    expect(isRecordOnlyBlock('webhook')).toBe(true)
    expect(isRecordOnlyBlock('trigger')).toBe(true)
  })
})

describe('coverageWarningLines', () => {
  it('emits a gap warning when there are unrecovered failures', () => {
    const lines = coverageWarningLines({
      failedBlockIds: ['event-click'],
      recordOnlyBlockIds: [],
      fromHistory: false,
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('coverage gap')
    expect(lines[0]).toContain('生成覆盖缺口')
  })

  it('emits nothing for a fully-executed, live-verified draft', () => {
    const lines = coverageWarningLines({
      failedBlockIds: [],
      recordOnlyBlockIds: [],
      fromHistory: false,
    })
    expect(lines).toHaveLength(0)
  })

  it('emits a record-only warning and a history-fallback warning', () => {
    const lines = coverageWarningLines({
      failedBlockIds: [],
      recordOnlyBlockIds: ['webhook'],
      fromHistory: true,
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Recorded without running')
    expect(lines[1]).toContain('Generated from action history')
  })
})
