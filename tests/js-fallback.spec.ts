import { describe, expect, it } from 'vitest'
import { evaluateCapabilityGap, hasNativeOperator } from '../src/lib/workflow/capability-gap'
import { operatorEntry } from '../src/lib/workflow/operator-registry'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
const gap = {
  missingCapability: 'shadow DOM canvas extraction',
  triedOperators: ['get-text', 'attribute-value'],
  whyInsufficient: 'Native blocks cannot reach the closed shadow root.',
  expectedResult: 'The extracted value is available in a variable.'
}
describe('29.9 javascript fallback', () => {
  it('rejects JS when a native operator exists', () => {
    const decision = evaluateCapabilityGap({ stepIntent: 'click the button', gap })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.nativeBlockIds).toContain('event-click')
  })
  it.each(['click the button', '填写邮箱', 'read text from heading'])('detects native coverage for: %s', (intent) => {
    expect(hasNativeOperator(intent)).toBe(true)
  })
  it('rejects JS for a real gap when the record is missing', () => {
    const decision = evaluateCapabilityGap({ stepIntent: 'extract data from a closed web component' })
    expect(decision.allowed).toBe(false)
  })
  it('allows JS only after a complete documented capability gap', () => {
    const decision = evaluateCapabilityGap({
      stepIntent: 'extract data from a closed web component', gap,
    })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.capabilityGap.missingCapability).toContain('shadow')
  })
})
describe('29.10 save-assets', () => {
  it('is present in the registry as an on-demand external operator', () => {
    const entry = operatorEntry('save-assets')
    expect(entry).toBeDefined()
    expect(entry!.aiExposure).toBe('on-demand')
    expect(entry!.sideEffect).toBe('external')
  })
  it('is flagged as having no executor (placeholder)', () => {
    const entry = operatorEntry('save-assets')
    expect(entry!.hasExecutor).toBe(false)
  })
  it('is discoverable only via its explicit semantic phrases', () => {
    const result = findWorkflowOperators({ stepIntent: 'save assets from the gallery', limit: 8 })
    expect(result.candidateBlockIds).toContain('save-assets')
  })
})