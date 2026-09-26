import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
import { evaluateCapabilityGap } from '../src/lib/workflow/capability-gap'
describe('V45 javascript is hidden by default', () => {
  it.each([
    'click the submit button',
    'fill the email field',
    'read the page heading text',
    'wait until the dialog appears',
    'navigate to the dashboard',
  ])('does not include javascript-code for: %s', (text) => {
    const result = findWorkflowOperators({ stepIntent: text })
    expect(result.candidateBlockIds).not.toContain('javascript-code')
  })
})
describe('V46 JS is rejected whenever a native capability exists', () => {
  const nativeCases = [
    { intent: 'interaction-click', label: 'click' },
    { intent: 'interaction-fill', label: 'fill form' },
    { intent: 'read text', label: 'read text' },
    { intent: 'read attribute', label: 'read attribute' },
    { intent: 'element exists', label: 'element-exists' },
    { intent: 'wait for element', label: 'wait' },
    { intent: 'branch on condition', label: 'condition' },
    { intent: 'loop over rows', label: 'loop' },
  ] as const
  it.each(nativeCases)('rejects JS for: $label', ({ intent }) => {
    const result = evaluateCapabilityGap({
      stepIntent: intent,
      gap: { missingCapability: 'x', triedOperators: [], whyInsufficient: '', expectedResult: '' },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds.length).toBeGreaterThan(0)
  })
})
describe('V47 capability gap gate', () => {
  it('rejects a gap record missing required fields', () => {
    const result = evaluateCapabilityGap({
      stepIntent: 'read encrypted payload inside a closed canvas widget',
      gap: { missingCapability: 'read canvas internals', triedOperators: [], whyInsufficient: '', expectedResult: '' },
    })
    expect(result.allowed).toBe(false)
  })
  it('allows JS only for a fully documented true gap', () => {
    const result = evaluateCapabilityGap({
      stepIntent: 'read encrypted payload inside a closed canvas widget',
      gap: {
        missingCapability: 'read closed-canvas widget payload',
        triedOperators: ['read-page', 'get-text', 'attribute-value'],
        whyInsufficient: 'The widget renders to canvas and exposes no DOM nodes or attributes.',
        expectedResult: 'The decoded payload string is captured.',
      },
    })
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.capabilityGap.triedOperators.length).toBeGreaterThanOrEqual(3)
      expect(result.capabilityGap.whyInsufficient).toBeTruthy()
      expect(result.capabilityGap.expectedResult).toBeTruthy()
    }
  })
})