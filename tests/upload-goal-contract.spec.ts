/**
 * upload-file structured Goal contract + failure-code tests (spec §12, §16).
 *
 * The registry builds an instantiated node contract from the block args, and
 * the failure classifier maps the structured upload error codes.
 */
import { describe, expect, it } from 'vitest'
import { operatorEntry } from '../src/lib/workflow/operator-registry'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import { hasNodeGoalContract, withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
import { classifyFailureMessage } from '../src/lib/workflow/failure-code'

describe('upload-file node goal contract', () => {
  it('builds an instantiated contract for user-select', () => {
    const contract = resolveNodeGoalContract('upload-file', {
      sourceMode: 'user-select',
      selector: '#avatar',
    })
    expect(contract?.goal).toMatch(/upload control.*#avatar/i)
    expect(contract?.successCriteria.length).toBeGreaterThanOrEqual(1)
    expect(contract?.failureMeaning?.length).toBeGreaterThanOrEqual(2)
    expect(contract?.repairHints?.length).toBeGreaterThanOrEqual(2)
  })

  it('builds an instantiated contract for workflow-file incl. the variable', () => {
    const contract = resolveNodeGoalContract('upload-file', {
      sourceMode: 'workflow-file',
      selector: 'input[type=file]',
      fileVariable: 'lastScreenshot',
    })
    expect(contract?.goal).toContain('lastScreenshot')
    expect(contract?.successCriteria.some((c) => c.kind === 'variableExists')).toBe(true)
  })

  it('returns undefined without a selector (no fabricated contract)', () => {
    const entry = operatorEntry('upload-file')
    expect(entry?.buildGoalContract?.({})).toBeUndefined()
  })

  it('contract survives the metadata namespace round trip', () => {
    const contract = resolveNodeGoalContract('upload-file', {
      sourceMode: 'user-select',
      selector: '#f',
    })!
    const data = withNodeGoalContract({}, contract)
    expect(hasNodeGoalContract(data)).toBe(true)
  })
})

describe('upload failure code classification', () => {
  const cases: [string, string][] = [
    ['UPLOAD_TARGET_NOT_FOUND: x', 'locator'],
    ['UPLOAD_FILE_VARIABLE_NOT_FOUND: x', 'workflow'],
    ['UPLOAD_USER_SELECTION_CANCELLED: x', 'cancelled'],
    ['UPLOAD_USER_SELECTION_TIMEOUT: x', 'environment'],
    ['UPLOAD_MULTIPLE_NOT_SUPPORTED: x', 'workflow'],
    ['UPLOAD_FILE_VERIFICATION_FAILED: x', 'workflow'],
  ]
  it.each(cases)('classifies %s', (message, category) => {
    expect(classifyFailureMessage(message).category).toBe(category)
  })
})
